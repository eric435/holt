/**
 * The screenshot note prompt's state machine (background/pending-screenshot.ts):
 * at most one pending screenshot, every screenshot ends up as exactly one
 * entry (with the note, or without it when the prompt is skipped, closed,
 * superseded or abandoned), and never twice.
 *
 * The module is chrome.* glue around that logic, so its collaborators are
 * replaced with in-memory fakes: storage.session and the pending
 * screenshot's storage.local backup (state.js), the popup
 * window (note-popup.js), the API client (server.js / api.js), the
 * notifications (notify.js), and `chrome.windows` for closing and looking
 * up the prompt window. What runs for real is the module's own ordering:
 * the serial chain and `take(id)`.
 */
import type { EntryInput } from "@holt/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../shared/api.js";
import type { PendingScreenshot } from "../shared/state.js";
import { PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS, PENDING_SCREENSHOT_TTL_MS } from "./pending-screenshot-model.js";

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    backup: { value: undefined as unknown },
    posted: [] as { serverUrl: string; entry: EntryInput }[],
    /** `failFor` decides per entry (e.g. only the screenshot entry is refused). */
    postEntry: { fail: null as Error | null, failFor: null as ((entry: EntryInput) => Error | null) | null, delayMs: 0 },
    notifyFails: false,
    openPopupWindow: { fail: null as Error | null, nextId: 100 },
    openWindows: new Set<number>(),
    removedWindows: [] as number[],
    toasts: [] as { level: string; message: string }[],
    added: [] as string[],
  };
});

vi.mock("../shared/state.js", () => ({
  getState: async (key: string) => structuredClone(h.store.get(key)),
  setState: async (key: string, value: unknown) => void h.store.set(key, structuredClone(value)),
  clearState: async (key: string) => void h.store.delete(key),
  getPendingScreenshotBackup: async () => structuredClone(h.backup.value),
  setPendingScreenshotBackup: async (value: unknown) => void (h.backup.value = structuredClone(value)),
  clearPendingScreenshotBackup: async () => void (h.backup.value = undefined),
}));

vi.mock("./note-popup.js", () => ({
  openPopupWindow: async () => {
    if (h.openPopupWindow.fail) throw h.openPopupWindow.fail;
    const id = h.openPopupWindow.nextId++;
    h.openWindows.add(id);
    return { id };
  },
}));

function fakeApi(serverUrl: string) {
  return {
    serverUrl,
    postEntry: async (entry: EntryInput) => {
      if (h.postEntry.delayMs) await new Promise((r) => setTimeout(r, h.postEntry.delayMs));
      if (h.postEntry.fail) throw h.postEntry.fail;
      const refused = h.postEntry.failFor?.(entry);
      if (refused) throw refused;
      h.posted.push({ serverUrl, entry });
      const seq = h.posted.length;
      return { ok: true, entry: { ...entry, id: `e${seq}`, seq, receivedAt: "t" }, session: { id: "s1" } };
    },
  };
}

vi.mock("../shared/server.js", () => ({ apiForServer: async (serverUrl: string) => fakeApi(serverUrl) }));
vi.mock("../shared/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/api.js")>()),
  getApi: async () => fakeApi("settings-url"),
}));

vi.mock("./notify.js", () => ({
  notifyEntryAdded: async (entry: { id: string }) => {
    if (h.notifyFails) throw new Error("storage quota");
    h.added.push(entry.id);
  },
  notifyToast: async (level: string, message: string) => {
    h.toasts.push({ level, message });
    return false;
  },
}));

type Module = typeof import("./pending-screenshot.js");
let m: Module;

const shot = (n: number): Omit<PendingScreenshot, "id" | "at" | "popupWindowId"> => ({
  page: { url: `http://localhost:5173/page-${n}`, title: `Page ${n}` },
  capturedAt: `2026-10-13T14:5${n}:00.000Z`,
  file: `00${n}-screenshot.png`,
  serverUrl: "http://localhost:5173",
  mode: "viewport",
  width: 800,
  height: 600,
  windowId: 1,
  tabId: 7,
});

const pending = () => h.store.get("pendingScreenshot") as PendingScreenshot | undefined;
const backup = () => h.backup.value as PendingScreenshot | undefined;
const postedFiles = () => h.posted.map((p) => `${(p.entry as { file?: string }).file ?? p.entry.kind}:${p.entry.note ?? ""}`);
/** What the server says when the screenshot's upload belongs to a session that has ended. */
const sessionGone = () => new ApiError("bad-request", '"file" "001-screenshot.png" is not an unused upload in the current session; upload it first', 400);
const refuseScreenshots = () => {
  h.postEntry.failFor = (entry) => (entry.kind === "screenshot" ? sessionGone() : null);
};

beforeEach(async () => {
  h.store.clear();
  h.backup.value = undefined;
  h.posted.length = 0;
  h.postEntry.fail = null;
  h.postEntry.failFor = null;
  h.notifyFails = false;
  h.postEntry.delayMs = 0;
  h.openPopupWindow.fail = null;
  h.openPopupWindow.nextId = 100;
  h.openWindows.clear();
  h.removedWindows.length = 0;
  h.toasts.length = 0;
  h.added.length = 0;
  vi.stubGlobal("chrome", {
    windows: {
      remove: async (id: number) => {
        h.removedWindows.push(id);
        h.openWindows.delete(id);
      },
      get: async (id: number) => {
        if (!h.openWindows.has(id)) throw new Error(`No window with id: ${id}.`);
        return { id };
      },
    },
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // A fresh module per test: the serial chain is module state.
  vi.resetModules();
  m = await import("./pending-screenshot.js");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("beginScreenshotNote", () => {
  it("stores the pending screenshot with the prompt's window, and posts nothing yet", async () => {
    await m.beginScreenshotNote(shot(1));
    expect(pending()).toMatchObject({ file: "001-screenshot.png", popupWindowId: 100 });
    expect(pending()?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.posted).toEqual([]);
  });

  it("a second screenshot posts the first without a note and closes its prompt", async () => {
    await m.beginScreenshotNote(shot(1));
    const first = pending()!;
    await m.beginScreenshotNote(shot(2));
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(h.removedWindows).toEqual([first.popupWindowId]);
    expect(pending()).toMatchObject({ file: "002-screenshot.png", popupWindowId: 101 });

    // The superseded prompt answering late changes nothing.
    expect(await m.finishScreenshotNote(first.id, "too late")).toEqual({ ok: true });
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(pending()?.file).toBe("002-screenshot.png");
  });

  it("posts without a note when the prompt window cannot be opened", async () => {
    h.openPopupWindow.fail = new Error("no window");
    await m.beginScreenshotNote(shot(1));
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(pending()).toBeUndefined();
  });

  it("a superseded screenshot whose post fails is reported, and the new one still goes ahead", async () => {
    await m.beginScreenshotNote(shot(1));
    h.postEntry.fail = new Error("server gone");
    await m.beginScreenshotNote(shot(2));
    expect(h.toasts).toEqual([{ level: "error", message: expect.stringMatching(/001-screenshot\.png is in the session folder.*server gone/) }]);
    expect(pending()?.file).toBe("002-screenshot.png");
  });
});

describe("finishScreenshotNote", () => {
  it("posts the entry with the trimmed note to the server the PNG went to", async () => {
    await m.beginScreenshotNote({ ...shot(1), serverUrl: "http://localhost:3000" });
    const result = await m.finishScreenshotNote(pending()!.id, "  Button overlaps the footer \n");
    expect(result).toMatchObject({ ok: true, entry: { file: "001-screenshot.png", note: "Button overlaps the footer" } });
    expect(h.posted[0]?.serverUrl).toBe("http://localhost:3000");
    expect(pending()).toBeUndefined();
    expect(h.added).toEqual(["e1"]);
  });

  it("Skip (empty note) posts the entry without a note key", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.finishScreenshotNote(pending()!.id, "");
    expect(h.posted[0]?.entry).not.toHaveProperty("note");
  });

  it("uses the settings' server for a pending screenshot from an older build (no serverUrl)", async () => {
    h.store.set("pendingScreenshot", { ...shot(1), serverUrl: "", id: "old", at: Date.now() });
    await m.finishScreenshotNote("old", "x");
    expect(h.posted[0]?.serverUrl).toBe("settings-url");
  });

  it("a failed post puts the screenshot back so the prompt can retry, and a retry posts it once", async () => {
    await m.beginScreenshotNote(shot(1));
    const id = pending()!.id;
    h.postEntry.fail = new Error("Can't reach the holt server");
    expect(await m.finishScreenshotNote(id, "note")).toEqual({ ok: false, error: "Can't reach the holt server" });
    expect(pending()?.id).toBe(id);

    h.postEntry.fail = null;
    expect(await m.finishScreenshotNote(id, "note")).toMatchObject({ ok: true, entry: { note: "note" } });
    expect(postedFiles()).toEqual(["001-screenshot.png:note"]);
  });

  it("an unknown id is answered ok without posting anything", async () => {
    await m.beginScreenshotNote(shot(1));
    expect(await m.finishScreenshotNote("someone-else", "x")).toEqual({ ok: true });
    expect(h.posted).toEqual([]);
    expect(pending()).toBeDefined();
  });
});

describe("never posted twice", () => {
  it("Save and the window closing at the same time: one entry, with the note", async () => {
    await m.beginScreenshotNote(shot(1));
    const { id, popupWindowId } = pending()!;
    h.postEntry.delayMs = 5;
    await Promise.all([m.finishScreenshotNote(id, "typed"), m.onPromptWindowClosed(popupWindowId!), m.finishScreenshotNote(id, "typed")]);
    expect(postedFiles()).toEqual(["001-screenshot.png:typed"]);
  });

  it("a new screenshot racing with the old prompt's Save: each screenshot once", async () => {
    await m.beginScreenshotNote(shot(1));
    const { id } = pending()!;
    h.postEntry.delayMs = 5;
    await Promise.all([m.beginScreenshotNote(shot(2)), m.finishScreenshotNote(id, "late note")]);
    // The first is posted exactly once (without the note: the new capture got there first).
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(pending()?.file).toBe("002-screenshot.png");
  });

  it("a worker start reconciling while the prompt answers: one entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await m.beginScreenshotNote(shot(1));
    const { id, popupWindowId } = pending()!;
    h.openWindows.delete(popupWindowId!);
    vi.setSystemTime(1_000_000 + PENDING_SCREENSHOT_TTL_MS + 1);
    await Promise.all([m.reconcilePendingScreenshot(), m.finishScreenshotNote(id, "x")]);
    expect(h.posted).toHaveLength(1);
  });
});

describe("onPromptWindowClosed", () => {
  it("posts without a note when the user closes the prompt", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.onPromptWindowClosed(pending()!.popupWindowId!);
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(pending()).toBeUndefined();
  });

  it("ignores other windows closing", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.onPromptWindowClosed(999);
    expect(h.posted).toEqual([]);
    expect(pending()).toBeDefined();
  });
});

describe("reconcilePendingScreenshot (worker start)", () => {
  const stored = (at: number, popupWindowId?: number): PendingScreenshot => ({
    ...shot(1),
    id: "p1",
    at,
    ...(popupWindowId !== undefined && { popupWindowId }),
  });

  it("does nothing without a pending screenshot", async () => {
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
  });

  it("leaves a young one alone, even without a window (the prompt may still be opening)", async () => {
    h.store.set("pendingScreenshot", stored(Date.now() - 1_000));
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
  });

  it("leaves an old one alone while its window is open (a slow typist is never cut off)", async () => {
    h.openWindows.add(55);
    h.store.set("pendingScreenshot", stored(Date.now() - PENDING_SCREENSHOT_TTL_MS - 60_000, 55));
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
    expect(pending()?.id).toBe("p1");
  });

  it("posts an old one whose window is gone, without a note", async () => {
    h.store.set("pendingScreenshot", stored(Date.now() - PENDING_SCREENSHOT_TTL_MS - 1, 55));
    await m.reconcilePendingScreenshot();
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(pending()).toBeUndefined();
  });
});

describe("the session ended under the open prompt (the server refuses the entry for good)", () => {
  it("Save: the screenshot is dropped and the words are saved as a separate note on the same server", async () => {
    await m.beginScreenshotNote({ ...shot(1), serverUrl: "http://localhost:3000" });
    refuseScreenshots();
    const result = await m.finishScreenshotNote(pending()!.id, " The footer overlaps ");
    expect(result).toMatchObject({ ok: true, sessionGone: true, entry: { kind: "note" } });
    expect(postedFiles()).toEqual(["note:About screenshot 001-screenshot.png from an earlier session: The footer overlaps"]);
    expect(h.posted[0]?.serverUrl).toBe("http://localhost:3000");
    expect(pending()).toBeUndefined();
    expect(backup()).toBeUndefined();
  });

  it("Skip: closes (ok) with nothing written, and says so", async () => {
    await m.beginScreenshotNote(shot(1));
    refuseScreenshots();
    expect(await m.finishScreenshotNote(pending()!.id, "")).toEqual({ ok: true, sessionGone: true });
    expect(h.posted).toEqual([]);
    expect(pending()).toBeUndefined();
    expect(h.toasts).toEqual([{ level: "error", message: expect.stringMatching(/001-screenshot\.png could not be added.*session has ended/) }]);
  });

  it("if the separate note can't be posted either, a retry posts only the note", async () => {
    await m.beginScreenshotNote(shot(1));
    const id = pending()!.id;
    h.postEntry.failFor = (entry) => (entry.kind === "screenshot" ? sessionGone() : new ApiError("unreachable", "server gone"));
    expect(await m.finishScreenshotNote(id, "words")).toEqual({ ok: false, error: "server gone" });
    expect(pending()).toMatchObject({ id, sessionGone: true });
    expect(backup()).toMatchObject({ id, sessionGone: true });

    h.postEntry.failFor = (entry) => (entry.kind === "screenshot" ? new Error("must not be tried again") : null);
    expect(await m.finishScreenshotNote(id, "words")).toMatchObject({ ok: true, sessionGone: true });
    expect(postedFiles()).toEqual(["note:About screenshot 001-screenshot.png from an earlier session: words"]);
  });

  it("an automatic path (the window closed) saves the draft as a note too", async () => {
    await m.beginScreenshotNote(shot(1));
    const { id, popupWindowId } = pending()!;
    await m.saveScreenshotDraft(id, "typed, then closed");
    refuseScreenshots();
    await m.onPromptWindowClosed(popupWindowId!);
    expect(postedFiles()).toEqual(["note:About screenshot 001-screenshot.png from an earlier session: typed, then closed"]);
  });

  it("a fixable 4xx (a wrong token) is not 'gone': Save keeps the screenshot for a retry", async () => {
    await m.beginScreenshotNote(shot(1));
    h.postEntry.fail = new ApiError("forbidden", 'Missing or wrong "x-holt-token" header', 403);
    expect(await m.finishScreenshotNote(pending()!.id, "note")).toMatchObject({ ok: false });
    expect(pending()?.sessionGone).toBeUndefined();
  });
});

describe("Skip always closes", () => {
  it("even when the server can't be reached: ok, the screenshot is given up and reported", async () => {
    await m.beginScreenshotNote(shot(1));
    h.postEntry.fail = new ApiError("unreachable", "Can't reach the holt server");
    expect(await m.finishScreenshotNote(pending()!.id, "")).toEqual({ ok: true });
    expect(pending()).toBeUndefined();
    expect(backup()).toBeUndefined();
    expect(h.toasts).toEqual([{ level: "error", message: expect.stringMatching(/001-screenshot\.png is in the session folder.*Can't reach/) }]);
  });

  it("Skip ignores a draft: the user chose no note", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.saveScreenshotDraft(pending()!.id, "never mind");
    await m.finishScreenshotNote(pending()!.id, "");
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
  });
});

describe("the prompt's draft", () => {
  it("is kept with the pending screenshot (and its backup); a stale prompt's draft is ignored", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.saveScreenshotDraft(pending()!.id, "half a th");
    expect(pending()?.draft).toBe("half a th");
    expect(backup()?.draft).toBe("half a th");
    await m.saveScreenshotDraft("someone-else", "nope");
    expect(pending()?.draft).toBe("half a th");
  });

  it("the next screenshot posts the previous one with its draft as the note", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.saveScreenshotDraft(pending()!.id, "typed before the next capture");
    await m.beginScreenshotNote(shot(2));
    expect(postedFiles()).toEqual(["001-screenshot.png:typed before the next capture"]);
    expect(pending()?.draft).toBeUndefined();
  });

  it("closing the window posts the draft as the note", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.saveScreenshotDraft(pending()!.id, "  closed with this  ");
    await m.onPromptWindowClosed(pending()!.popupWindowId!);
    expect(postedFiles()).toEqual(["001-screenshot.png:closed with this"]);
  });

  it("a failed automatic post shows the words, so they can be copied", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.saveScreenshotDraft(pending()!.id, "my words");
    h.postEntry.fail = new ApiError("unreachable", "down");
    await m.onPromptWindowClosed(pending()!.popupWindowId!);
    expect(h.toasts[0]?.message).toMatch(/Your note was: “my words”/);
  });
});

describe("saved, but the announcement fails", () => {
  it("is still a successful save (a retry would be refused as a duplicate)", async () => {
    await m.beginScreenshotNote(shot(1));
    h.notifyFails = true;
    expect(await m.finishScreenshotNote(pending()!.id, "note")).toMatchObject({ ok: true, entry: { note: "note" } });
    expect(pending()).toBeUndefined();
    expect(h.posted).toHaveLength(1);
  });
});

describe("the storage.local backup (quitting the browser with the prompt open)", () => {
  const saved = (overrides: Partial<PendingScreenshot> = {}): PendingScreenshot => ({ ...shot(1), id: "b1", at: Date.now(), popupWindowId: 55, ...overrides });

  it("mirrors the pending screenshot, and goes once its entry is written", async () => {
    await m.beginScreenshotNote(shot(1));
    expect(backup()).toEqual(pending());
    await m.finishScreenshotNote(pending()!.id, "x");
    expect(backup()).toBeUndefined();
  });

  it("is kept while a Save fails, so a restart can still write it", async () => {
    await m.beginScreenshotNote(shot(1));
    h.postEntry.fail = new ApiError("unreachable", "down");
    await m.finishScreenshotNote(pending()!.id, "x");
    expect(backup()?.id).toBe(pending()?.id);
  });

  it("after a restart (no session state), a worker start posts it with its draft", async () => {
    h.backup.value = saved({ draft: "typed before quitting" });
    await m.reconcilePendingScreenshot();
    expect(postedFiles()).toEqual(["001-screenshot.png:typed before quitting"]);
    expect(backup()).toBeUndefined();
  });

  it("a session that ended meanwhile: the draft becomes a note; without one it is dropped quietly", async () => {
    refuseScreenshots();
    h.backup.value = saved({ draft: "words" });
    await m.reconcilePendingScreenshot();
    expect(postedFiles()).toEqual(["note:About screenshot 001-screenshot.png from an earlier session: words"]);

    h.posted.length = 0;
    h.backup.value = saved({ id: "b2" });
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
    expect(backup()).toBeUndefined();
    expect(h.toasts).toEqual([]);
  });

  it("server not up yet: kept for the next worker start, without bothering the user", async () => {
    h.postEntry.fail = new ApiError("unreachable", "down");
    h.backup.value = saved();
    await m.reconcilePendingScreenshot();
    expect(backup()?.id).toBe("b1");
    expect(h.toasts).toEqual([]);
    h.postEntry.fail = null;
    await m.reconcilePendingScreenshot();
    expect(postedFiles()).toEqual(["001-screenshot.png:"]);
    expect(backup()).toBeUndefined();
  });

  it("too old: dropped", async () => {
    h.backup.value = saved({ at: Date.now() - PENDING_SCREENSHOT_BACKUP_MAX_AGE_MS - 1 });
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
    expect(backup()).toBeUndefined();
  });

  it("left alone while it is the session's own pending screenshot", async () => {
    await m.beginScreenshotNote(shot(1));
    await m.reconcilePendingScreenshot();
    expect(h.posted).toEqual([]);
    expect(backup()?.id).toBe(pending()?.id);
  });
});
