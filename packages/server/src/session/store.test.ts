import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EntryInput } from "@nitpick/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionError, SessionStore, assertInside } from "./store.js";

let root: string;
let outputDir: string;
let clock: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nitpick-store-"));
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
  text,
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

describe("assertInside", () => {
  it("accepts children and rejects the parent itself, siblings and prefixes", () => {
    expect(() => assertInside("/out", "/out/a/b.png")).not.toThrow();
    expect(() => assertInside("/out", "/out/..data")).not.toThrow();
    expect(() => assertInside("/out", "/out")).toThrow();
    expect(() => assertInside("/out", "/out-evil/a.png")).toThrow();
    expect(() => assertInside("/out", "/a.png")).toThrow();
  });
});
