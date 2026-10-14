/**
 * SessionStore: owns "the one active session" (docs/ARCHITECTURE.md) and is
 * the only code that creates folders or writes into them.
 *
 * Lifecycle:
 *   start(title?)  close any active session, create <outputDir>/<timestamp>/
 *                  and write the notes.md header.
 *   reserveMedia   pick the next sequence number and a file name for an upload
 *                  (auto-starting a session if needed) and remember it as
 *                  "uploaded, waiting for its entry".
 *   finishMedia    after the bytes are on disk: confirm the session the
 *                  upload was reserved in is still the active one.
 *   addEntry       append an entry to notes.md (auto-starting if needed). A
 *                  media entry reuses its upload's sequence number, so
 *                  "## 3. Screenshot" links to "003-screenshot.png".
 *   stop()         append the end marker and forget the session.
 *
 * Concurrency: the HTTP server can run several requests at once, and two
 * "first screenshot" requests arriving together must not create two
 * sessions. Every state change therefore runs through `exclusive()`, a
 * promise chain that runs one operation at a time. (Streaming the upload
 * bytes happens outside the lock, so a big recording does not block notes.)
 *
 * Session identity: uploads stream *outside* the lock, so a session can end
 * (and a new one start) while bytes are still arriving. Every session gets
 * a `generation` number, and a reservation remembers the generation it was
 * made in. Releasing or finishing a reservation only ever acts on that
 * generation, never on whatever session happens to be active by then.
 * (Folder ids are not enough: a new session can reuse a file name like
 * "001-screenshot.png", and in rare cases even a folder name.)
 *
 * State is in memory only. If the server restarts, the next capture starts
 * a fresh session folder; old folders are never modified again.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_FILE_NAME, type Entry, type EntryInput, type SessionInfo } from "@holt/protocol";
import { MAX_PENDING_UPLOADS } from "../config/defaults.js";
import { renderEntry, renderFooter, renderHeader } from "./markdown.js";
import { isPlainFileName, mediaFileName, sessionFolderName, type MediaKind } from "./naming.js";

/**
 * A problem caused by the client's request rather than a server bug. The
 * HTTP layer maps `reason` to a status: "invalid" -> 400, "conflict" -> 409,
 * "limit" -> 429. (The store itself knows nothing about HTTP.)
 */
export type SessionErrorReason = "invalid" | "conflict" | "limit";

export class SessionError extends Error {
  override name = "SessionError";

  constructor(
    message: string,
    readonly reason: SessionErrorReason = "invalid",
  ) {
    super(message);
  }
}

export interface SessionStoreOptions {
  /** Absolute project root (for display paths and the notes header). */
  root: string;
  /** Absolute directory that holds session folders. */
  outputDir: string;
  /** Title used when start() is called without one, and for auto-started sessions. */
  defaultTitle: string;
  /** Injectable clock, for tests. */
  now?: () => Date;
}

interface ActiveSession {
  /** Unique per store instance; see "Session identity" above. */
  generation: number;
  id: string;
  dir: string;
  notesPath: string;
  startedAt: Date;
  entryCount: number;
  /** Highest sequence number handed out so far (entries and media share it). */
  lastSeq: number;
  /** Uploaded media not yet referenced by an entry, by file name. */
  pendingMedia: Map<string, PendingMedia>;
}

interface PendingMedia {
  seq: number;
  /** The upload's `x-holt-kind`, which is also in its file name. */
  kind: MediaKind;
}

export interface ReservedMedia {
  session: SessionInfo;
  /** Identity of the session this reservation belongs to. */
  sessionGeneration: number;
  seq: number;
  /** Bare file name to return to the client, e.g. "001-screenshot.png". */
  file: string;
  /** Absolute, checked path to write the bytes to. */
  path: string;
}

/**
 * Written into the output directory when holt creates it. Screenshots can
 * contain anything that was on screen, so sessions are not committed unless
 * you decide to (docs/SECURITY.md).
 */
const OUTPUT_GITIGNORE = `# Created by holt. QA sessions can contain screenshots of anything that
# was on your screen, so they are ignored by default. Delete or edit this
# file if you want to commit sessions.
*
`;

export class SessionStore {
  private readonly root: string;
  private readonly outputDir: string;
  private readonly defaultTitle: string;
  private readonly now: () => Date;
  private session: ActiveSession | null = null;
  private generations = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SessionStoreOptions) {
    this.root = path.resolve(options.root);
    this.outputDir = path.resolve(options.outputDir);
    this.defaultTitle = options.defaultTitle;
    this.now = options.now ?? (() => new Date());
  }

  /** Public view of the active session, or null. */
  get current(): SessionInfo | null {
    return this.session ? this.toInfo(this.session) : null;
  }

  /** Start a new session, ending the active one first. */
  start(title?: string): Promise<SessionInfo> {
    return this.exclusive(async () => this.toInfo(await this.startUnlocked(title)));
  }

  /** End the active session. Returns it (with endedAt), or null if none was active. */
  stop(): Promise<SessionInfo | null> {
    return this.exclusive(() => this.stopUnlocked());
  }

  /** Return the active session, starting one if needed. */
  ensureActive(): Promise<SessionInfo> {
    return this.exclusive(async () => this.toInfo(await this.activeUnlocked()));
  }

  /**
   * Hand out the next sequence number of the active session. Synchronous on
   * purpose: JavaScript cannot interleave inside it, so two callers can
   * never receive the same number.
   */
  nextSeq(): number {
    const session = this.requireActive();
    session.lastSeq += 1;
    return session.lastSeq;
  }

  /**
   * Resolve a bare file name to an absolute path inside the active session
   * folder, refusing anything that could land elsewhere. Names we generate
   * always pass; this is the backstop in case a future change ever lets a
   * client-supplied string through.
   */
  resolveMediaPath(fileName: string): string {
    const session = this.requireActive();
    if (!isPlainFileName(fileName) || fileName === SESSION_FILE_NAME) {
      throw new SessionError(`Invalid file name: ${JSON.stringify(fileName)}`);
    }
    const full = path.resolve(session.dir, fileName);
    assertInside(session.dir, full);
    assertInside(this.outputDir, full);
    return full;
  }

  /**
   * Reserve a sequence number and file path for an incoming upload.
   * At most MAX_PENDING_UPLOADS uploads may wait for their entry at once;
   * without a cap, a client could fill the disk with files that never show
   * up in notes.md.
   */
  reserveMedia(kind: MediaKind, ext: string): Promise<ReservedMedia> {
    return this.exclusive(async () => {
      const session = await this.activeUnlocked();
      if (session.pendingMedia.size >= MAX_PENDING_UPLOADS) {
        throw new SessionError(
          `Too many uploads (${MAX_PENDING_UPLOADS}) are waiting for an entry in this session. ` +
            `Post entries for them (or start a new session) before uploading more.`,
          "limit",
        );
      }
      const seq = this.nextSeq();
      const file = mediaFileName(seq, kind, ext);
      const filePath = this.resolveMediaPath(file);
      session.pendingMedia.set(file, { seq, kind });
      return { session: this.toInfo(session), sessionGeneration: session.generation, seq, file, path: filePath };
    });
  }

  /**
   * Forget a reservation whose upload failed (the caller deletes the
   * partial file). Only touches the session the reservation was made in: if
   * that session already ended, there is nothing to release, and a newer
   * session's reservation with the same file name must not be cancelled.
   */
  releaseMedia(media: ReservedMedia): void {
    if (this.session?.generation === media.sessionGeneration) {
      this.session.pendingMedia.delete(media.file);
    }
  }

  /**
   * Call once an upload's bytes are fully on disk. If the session it was
   * reserved in is no longer active (stopped or replaced mid-upload), the
   * file is deleted and a "conflict" SessionError is thrown: the client
   * must not reference a file in a session that has ended.
   */
  finishMedia(media: ReservedMedia): Promise<SessionInfo> {
    return this.exclusive(async () => {
      const session = this.session;
      if (session?.generation !== media.sessionGeneration) {
        await rm(media.path, { force: true });
        throw new SessionError(
          "The session changed while this file was uploading, so it was discarded. Upload it again.",
          "conflict",
        );
      }
      return this.toInfo(session);
    });
  }

  /** Validate, number, render and append an entry. */
  addEntry(input: EntryInput): Promise<{ entry: Entry; session: SessionInfo }> {
    return this.exclusive(async () => {
      const session = await this.activeUnlocked();

      let seq: number;
      const file = "file" in input ? input.file : undefined;
      if (file !== undefined) {
        seq = await this.claimMedia(session, file, input.kind);
      } else {
        seq = this.nextSeq();
      }

      const entry: Entry = {
        ...input,
        id: randomUUID(),
        seq,
        receivedAt: this.now().toISOString(),
      };
      // Append-only: notes.md is never read back or rewritten, so a crash
      // can at worst lose the entry being written, never earlier ones.
      await appendFile(session.notesPath, renderEntry(entry), "utf8");
      session.entryCount += 1;
      if (file !== undefined) session.pendingMedia.delete(file);
      return { entry, session: this.toInfo(session) };
    });
  }

  // --- internals ------------------------------------------------------------

  /**
   * Run `fn` after every previously queued operation has finished. Methods
   * called from inside `fn` must be the *Unlocked variants, or they would
   * wait for themselves forever.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // Keep the chain alive even if this operation fails.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async activeUnlocked(): Promise<ActiveSession> {
    return this.session ?? (await this.startUnlocked());
  }

  private async startUnlocked(title?: string): Promise<ActiveSession> {
    await this.stopUnlocked();

    const startedAt = this.now();
    const createdOutputDir = await mkdir(this.outputDir, { recursive: true });
    if (createdOutputDir !== undefined) {
      // Only when *we* created the directory: never touch a folder the user
      // already had (it could be the repo root, or their ignore rules).
      await writeFile(path.join(this.outputDir, ".gitignore"), OUTPUT_GITIGNORE, { flag: "wx" });
    }

    const { id, dir } = await this.createSessionDir(sessionFolderName(startedAt));
    const notesPath = path.join(dir, SESSION_FILE_NAME);
    // "wx": fail rather than overwrite if the file somehow exists already.
    await writeFile(
      notesPath,
      renderHeader({ title: title ?? this.defaultTitle, startedAt, root: this.root }),
      { encoding: "utf8", flag: "wx" },
    );

    this.generations += 1;
    this.session = {
      generation: this.generations,
      id,
      dir,
      notesPath,
      startedAt,
      entryCount: 0,
      lastSeq: 0,
      pendingMedia: new Map(),
    };
    return this.session;
  }

  private async stopUnlocked(): Promise<SessionInfo | null> {
    const session = this.session;
    if (!session) return null;
    // Forget the session first: even if the footer write fails, new
    // captures must go to a new session rather than an ended one.
    this.session = null;
    const endedAt = this.now();
    await appendFile(session.notesPath, renderFooter(endedAt, session.entryCount), "utf8");
    return { ...this.toInfo(session), endedAt: endedAt.toISOString() };
  }

  /**
   * Create the session folder. Two sessions started within the same second
   * would collide, so on EEXIST we add a suffix (`-2`, `-3`, ...). mkdir
   * without `recursive` is atomic, so this is also safe against races.
   */
  private async createSessionDir(baseName: string): Promise<{ id: string; dir: string }> {
    for (let attempt = 1; attempt <= 100; attempt++) {
      const id = attempt === 1 ? baseName : `${baseName}-${attempt}`;
      const dir = path.resolve(this.outputDir, id);
      assertInside(this.outputDir, dir);
      try {
        await mkdir(dir);
        return { id, dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`Could not create a session folder for ${baseName} in ${this.outputDir}`);
  }

  /**
   * Check that an entry's `file` is a media file uploaded in this session
   * for this kind of entry and not used by another entry yet, and return
   * its sequence number.
   *
   * Why the kind check: the kind is part of the file name, so without it
   * "001-screenshot.png" could back a "🎬 Recording" and notes.md would say
   * one thing while the folder says another. An upload sent without
   * `x-holt-kind` is named "NNN-media.ext", which claims nothing, so any
   * media entry may use it.
   */
  private async claimMedia(session: ActiveSession, file: string, entryKind: EntryInput["kind"]): Promise<number> {
    if (!isPlainFileName(file)) {
      throw new SessionError(`"file" must be a bare file name returned by the media upload`);
    }
    const pending = session.pendingMedia.get(file);
    if (pending === undefined) {
      throw new SessionError(
        `"file" ${JSON.stringify(file)} is not an unused upload in the current session; upload it first`,
      );
    }
    if (pending.kind !== "media" && pending.kind !== entryKind) {
      throw new SessionError(
        `"file" ${JSON.stringify(file)} was uploaded for a different entry kind ` +
          `(${pending.kind}, not ${entryKind}); upload it with ${JSON.stringify(entryKind)} as the kind`,
      );
    }
    const info = await stat(this.resolveMediaPath(file)).catch(() => null);
    if (!info?.isFile()) {
      throw new SessionError(`"file" ${JSON.stringify(file)} does not exist in the current session`);
    }
    return pending.seq;
  }

  private requireActive(): ActiveSession {
    if (!this.session) throw new Error("No active session");
    return this.session;
  }

  private toInfo(session: ActiveSession): SessionInfo {
    return {
      id: session.id,
      dir: session.dir,
      markdownFile: path.relative(this.root, session.notesPath),
      startedAt: session.startedAt.toISOString(),
      entryCount: session.entryCount,
    };
  }
}

/**
 * Throw unless `child` is strictly inside `parent`. Both must be absolute,
 * resolved paths. `path.relative` is used instead of `startsWith` because
 * "/out-evil" starts with "/out" but is not inside it.
 */
export function assertInside(parent: string, child: string): void {
  const rel = path.relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new SessionError(`Refusing to write outside ${parent}`);
  }
}
