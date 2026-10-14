import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EntryInput } from "@holt/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PENDING_UPLOADS } from "../config/defaults.js";
import { SessionError, SessionStore, assertInside } from "./store.js";

let root: string;
let outputDir: string;
let clock: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "holt-store-"));
  outputDir = path.join(root, "qa");
  clock = new Date(2026, 9, 13, 7, 52, 0);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function createStore(): SessionStore {
  return new SessionStore({ root, outputDir, defaultTitle: "QA session", now: () => clock });
}

const note = (text: string): EntryInput => ({
  kind: "note",
  capturedAt: clock.toISOString(),
  page: { url: "http://localhost/", title: "Home" },
  note: text,
});

describe("SessionStore", () => {
  it("has no session until one is started", () => {
    expect(createStore().current).toBeNull();
  });

  it("start() creates the timestamped folder, notes.md header, and a self-ignoring output dir", async () => {
    const store = createStore();
    const session = await store.start("Checkout pass");

    expect(session.id).toBe("2026-10-13-075200");
    expect(session.dir).toBe(path.join(outputDir, "2026-10-13-075200"));
    expect(session.markdownFile).toBe(path.join("qa", "2026-10-13-075200", "notes.md"));
    expect(session.entryCount).toBe(0);

    const notes = await readFile(path.join(session.dir, "notes.md"), "utf8");
    expect(notes).toMatch(/^# Checkout pass 2026-10-13 07:52\n/);
    expect(await readFile(path.join(outputDir, ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });

  it("does not add a .gitignore to an output dir that already existed", async () => {
    await mkdir(outputDir);
    await createStore().start();
    expect(await readdir(outputDir)).not.toContain(".gitignore");
  });

  it("uses a suffix when two sessions start in the same second", async () => {
    const store = createStore();
    const first = await store.start();
    const second = await store.start();
    expect(first.id).toBe("2026-10-13-075200");
    expect(second.id).toBe("2026-10-13-075200-2");
  });

  it("stop() appends the end marker and clears the session; start() after stop() begins a new one", async () => {
    const store = createStore();
    const first = await store.start();
    await store.addEntry(note("hello"));
    clock = new Date(2026, 9, 13, 8, 0, 0);

    const ended = await store.stop();
    expect(ended?.id).toBe(first.id);
    expect(ended?.endedAt).toBe(clock.toISOString());
    expect(ended?.entryCount).toBe(1);
    expect(store.current).toBeNull();
    expect(await readFile(path.join(first.dir, "notes.md"), "utf8")).toMatch(
      /\n---\n\n_Session ended at 2026-10-13T08:00:00.* \(1 entry\)\._\n$/,
    );

    expect(await store.stop()).toBeNull(); // idempotent

    const second = await store.start();
    expect(second.id).toBe("2026-10-13-080000");
    expect(second.entryCount).toBe(0);
  });

  it("start() while a session is active ends the previous one", async () => {
    const store = createStore();
    const first = await store.start();
    clock = new Date(2026, 9, 13, 9, 0, 0);
    await store.start();
    expect(await readFile(path.join(first.dir, "notes.md"), "utf8")).toContain("_Session ended at");
  });

  it("auto-starts a session for the first entry, and concurrent first entries share it", async () => {
    const store = createStore();
    await Promise.all([store.addEntry(note("a")), store.addEntry(note("b")), store.addEntry(note("c"))]);
    expect(await readdir(outputDir)).toEqual([".gitignore", "2026-10-13-075200"]);
    expect(store.current?.entryCount).toBe(3);
  });

  it("increments the sequence across media and entries", async () => {
    const store = createStore();
    await store.start();
    expect(store.nextSeq()).toBe(1);
    expect(store.nextSeq()).toBe(2);
    const { entry } = await store.addEntry(note("x"));
    expect(entry.seq).toBe(3);
    const media = await store.reserveMedia("screenshot", "png");
    expect(media.seq).toBe(4);
    expect(media.file).toBe("004-screenshot.png");
  });

  it("a media entry takes its upload's sequence number, and each upload can be used once", async () => {
    const store = createStore();
    const media = await store.reserveMedia("screenshot", "png");
    await writeFile(media.path, "png-bytes");
    await store.addEntry(note("between"));

    const { entry } = await store.addEntry({
      kind: "screenshot",
      capturedAt: clock.toISOString(),
      page: { url: "http://localhost/", title: "Home" },
      file: media.file,
      mode: "viewport",
      width: 10,
      height: 10,
    });
    expect(entry.seq).toBe(1);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);

    const notes = await readFile(path.join(media.session.dir, "notes.md"), "utf8");
    expect(notes.indexOf("## 2. Note")).toBeLessThan(notes.indexOf("## 1. Screenshot"));

    await expect(
      store.addEntry({
        kind: "recording",
        capturedAt: clock.toISOString(),
        page: { url: "", title: "" },
        file: media.file,
        durationMs: 1,
      }),
    ).rejects.toThrow(/not an unused upload/);
  });

  it("rejects an entry whose upload was made for a different kind, and leaves the upload claimable", async () => {
    const store = createStore();
    const shot = await store.reserveMedia("screenshot", "png");
    await writeFile(shot.path, "png-bytes");
    const base = { capturedAt: clock.toISOString(), page: { url: "", title: "" } };

    for (const input of [
      { ...base, kind: "recording", file: shot.file, durationMs: 1 },
      { ...base, kind: "voice-note", file: shot.file, durationMs: 1 },
    ] as EntryInput[]) {
      const error = await store.addEntry(input).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).reason).toBe("invalid");
      expect((error as SessionError).message).toMatch(
        /"001-screenshot\.png" was uploaded for a different entry kind \(screenshot, not (recording|voice-note)\)/,
      );
    }
    expect(store.current?.entryCount).toBe(0);
    expect(await readFile(path.join(shot.session.dir, "notes.md"), "utf8")).not.toMatch(/## \d/);

    const { entry } = await store.addEntry({ ...base, kind: "screenshot", file: shot.file, mode: "area", width: 1, height: 1 });
    expect(entry.seq).toBe(1);
  });

  it("an upload without a kind ('media') can back any media entry", async () => {
    const store = createStore();
    const media = await store.reserveMedia("media", "webm");
    await writeFile(media.path, "webm");
    const { entry } = await store.addEntry({
      kind: "voice-note",
      capturedAt: clock.toISOString(),
      page: { url: "", title: "" },
      file: media.file,
      durationMs: 1,
    });
    expect(entry).toMatchObject({ seq: 1, file: "001-media.webm" });
  });

  it("rejects entries for files that were reserved but never written", async () => {
    const store = createStore();
    const media = await store.reserveMedia("recording", "webm");
    await expect(
      store.addEntry({
        kind: "recording",
        capturedAt: clock.toISOString(),
        page: { url: "", title: "" },
        file: media.file,
        durationMs: 1,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  describe("reservations across session changes", () => {
    const recordingFor = (file: string): EntryInput => ({
      kind: "recording",
      capturedAt: clock.toISOString(),
      page: { url: "", title: "" },
      file,
      durationMs: 1,
    });

    it("releasing a reservation from an ended session does not cancel a new session's reservation of the same name", async () => {
      const store = createStore();
      const old = await store.reserveMedia("recording", "webm");
      await store.start(); // ends the old session; same second, so the folder gets a -2 suffix
      const fresh = await store.reserveMedia("recording", "webm");
      expect(fresh.file).toBe(old.file); // both "001-recording.webm"
      expect(fresh.sessionGeneration).not.toBe(old.sessionGeneration);

      store.releaseMedia(old); // the old upload failed late
      await writeFile(fresh.path, "bytes");
      const { entry } = await store.addEntry(recordingFor(fresh.file));
      expect(entry.seq).toBe(1);
    });

    it("finishMedia confirms the session when it is unchanged", async () => {
      const store = createStore();
      const media = await store.reserveMedia("screenshot", "png");
      await writeFile(media.path, "bytes");
      expect((await store.finishMedia(media)).id).toBe(media.session.id);
    });

    it("finishMedia rejects with a conflict and deletes the file if the session changed mid-upload", async () => {
      const store = createStore();
      const media = await store.reserveMedia("screenshot", "png");

      // Manual promise standing in for a slow upload: the bytes arrive only
      // after a new session has started.
      let finishUpload!: () => void;
      const upload = new Promise<void>((resolve) => (finishUpload = resolve)).then(() => writeFile(media.path, "late"));
      clock = new Date(2026, 9, 13, 8, 0, 0);
      const fresh = await store.start();
      finishUpload();
      await upload;

      const error = await store.finishMedia(media).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).reason).toBe("conflict");
      expect(await readdir(media.session.dir)).toEqual(["notes.md"]); // late file removed
      expect(store.current?.id).toBe(fresh.id);
    });

    it("finishMedia rejects if the session was stopped mid-upload", async () => {
      const store = createStore();
      const media = await store.reserveMedia("screenshot", "png");
      await store.stop();
      await writeFile(media.path, "late");
      await expect(store.finishMedia(media)).rejects.toMatchObject({ reason: "conflict" });
    });
  });

  it("caps uploads waiting for an entry, and frees a slot when one is used or released", async () => {
    const store = createStore();
    const reserved = [];
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++) reserved.push(await store.reserveMedia("screenshot", "png"));
    await expect(store.reserveMedia("screenshot", "png")).rejects.toMatchObject({ reason: "limit" });

    store.releaseMedia(reserved[0]!);
    const next = await store.reserveMedia("screenshot", "png");
    await expect(store.reserveMedia("screenshot", "png")).rejects.toMatchObject({ reason: "limit" });

    await writeFile(next.path, "bytes");
    await store.addEntry({
      kind: "screenshot",
      capturedAt: clock.toISOString(),
      page: { url: "", title: "" },
      file: next.file,
      mode: "viewport",
      width: 1,
      height: 1,
    });
    await expect(store.reserveMedia("screenshot", "png")).resolves.toBeDefined();

    // A new session starts with an empty count.
    await store.start();
    await expect(store.reserveMedia("screenshot", "png")).resolves.toBeDefined();
  });

  describe("resolveMediaPath", () => {
    it("resolves plain names inside the session folder", async () => {
      const store = createStore();
      const session = await store.start();
      expect(store.resolveMediaPath("001-screenshot.png")).toBe(path.join(session.dir, "001-screenshot.png"));
    });

    it.each([
      "../escape.png",
      "../../etc/passwd",
      "/etc/passwd",
      "sub/dir.png",
      "..",
      ".",
      "",
      "a\\..\\b.png",
      "C:\\Windows\\x.png",
      "notes.md",
      ".gitignore",
    ])("rejects %j", async (name) => {
      const store = createStore();
      await store.start();
      expect(() => store.resolveMediaPath(name)).toThrow(SessionError);
    });

    it("throws when no session is active", () => {
      expect(() => createStore().resolveMediaPath("001-x.png")).toThrow(/No active session/);
    });
  });
});

describe("SessionStore: media claims and session ends under concurrency", () => {
  const screenshotFor = (file: string): EntryInput => ({
    kind: "screenshot",
    capturedAt: clock.toISOString(),
    page: { url: "http://localhost/", title: "Home" },
    file,
    mode: "viewport",
    width: 1,
    height: 1,
  });

  it("two entries racing for the same upload: exactly one gets it", async () => {
    const store = createStore();
    const media = await store.reserveMedia("screenshot", "png");
    await writeFile(media.path, "png");

    const results = await Promise.allSettled([store.addEntry(screenshotFor(media.file)), store.addEntry(screenshotFor(media.file))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SessionError);
    expect(String(rejected.reason)).toMatch(/not an unused upload/);

    const notes = await readFile(path.join(media.session.dir, "notes.md"), "utf8");
    expect(notes.match(/001-screenshot\.png/g)).toHaveLength(1);
    expect(store.current?.entryCount).toBe(1);
  });

  it("an upload from an ended session cannot be claimed by the next one, and stays where it was", async () => {
    const store = createStore();
    const old = await store.reserveMedia("screenshot", "png");
    await writeFile(old.path, "png");
    clock = new Date(2026, 9, 13, 8, 0, 0);
    const fresh = await store.start();

    await expect(store.addEntry(screenshotFor(old.file))).rejects.toThrow(/not an unused upload/);
    expect(await readdir(old.session.dir)).toEqual(["001-screenshot.png", "notes.md"]);
    expect(await readFile(path.join(fresh.dir, "notes.md"), "utf8")).not.toContain("screenshot.png");
  });

  it("a released reservation cannot be claimed, even if a file appears at its path", async () => {
    const store = createStore();
    const media = await store.reserveMedia("screenshot", "png");
    store.releaseMedia(media);
    await writeFile(media.path, "png");
    await expect(store.addEntry(screenshotFor(media.file))).rejects.toThrow(/not an unused upload/);
  });

  it("uploads nobody wrote an entry for are left on disk, unlinked, and not counted", async () => {
    const store = createStore();
    const media = await store.reserveMedia("screenshot", "png");
    await writeFile(media.path, "png");
    await store.addEntry(note("only this"));
    const ended = await store.stop();

    expect(ended?.entryCount).toBe(1);
    const notes = await readFile(path.join(media.session.dir, "notes.md"), "utf8");
    expect(notes).not.toContain(media.file);
    expect(notes).toMatch(/\(1 entry\)\._\n$/);
    expect(await readdir(media.session.dir)).toContain(media.file);
  });

  it("stop() racing with an entry: the entry is written before the end marker", async () => {
    const store = createStore();
    const session = await store.start();
    await Promise.all([store.addEntry(note("last words")), store.stop()]);
    const notes = await readFile(path.join(session.dir, "notes.md"), "utf8");
    expect(notes.indexOf("last words")).toBeGreaterThan(-1);
    expect(notes.indexOf("last words")).toBeLessThan(notes.indexOf("_Session ended"));
    expect(notes).toContain("(1 entry)");
  });

  it("two stops at once write one end marker; the second reports no session", async () => {
    const store = createStore();
    const session = await store.start();
    const [a, b] = await Promise.all([store.stop(), store.stop()]);
    expect(a?.id).toBe(session.id);
    expect(b).toBeNull();
    const notes = await readFile(path.join(session.dir, "notes.md"), "utf8");
    expect(notes.match(/_Session ended/g)).toHaveLength(1);
  });

  it("an entry after stop() starts a new session instead of writing into the ended one", async () => {
    const store = createStore();
    const first = await store.start();
    await store.stop();
    clock = new Date(2026, 9, 13, 8, 0, 0);
    const { session } = await store.addEntry(note("after"));
    expect(session.id).not.toBe(first.id);
    expect(await readFile(path.join(first.dir, "notes.md"), "utf8")).not.toContain("after");
  });

  it("a voice note with words only takes a fresh sequence number; with audio, its upload's", async () => {
    const store = createStore();
    const audio = await store.reserveMedia("voice-note", "webm");
    await writeFile(audio.path, "webm");
    const wordsOnly = await store.addEntry({
      kind: "voice-note",
      capturedAt: clock.toISOString(),
      page: { url: "", title: "" },
      durationMs: 1000,
      note: "words",
    });
    const withAudio = await store.addEntry({
      kind: "voice-note",
      capturedAt: clock.toISOString(),
      page: { url: "", title: "" },
      durationMs: 1000,
      file: audio.file,
    });
    expect(wordsOnly.entry.seq).toBe(2);
    expect(withAudio.entry.seq).toBe(1);
  });
});

describe("assertInside", () => {
  it("accepts children and rejects the parent itself, siblings and prefixes", () => {
    expect(() => assertInside("/out", "/out/a/b.png")).not.toThrow();
    expect(() => assertInside("/out", "/out/..data")).not.toThrow();
    expect(() => assertInside("/out", "/out")).toThrow();
    expect(() => assertInside("/out", "/out-evil/a.png")).toThrow();
    expect(() => assertInside("/out", "/a.png")).toThrow();
  });
});
