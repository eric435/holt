/**
 * The recent-entries list (shared/state.ts): its pure update, and that
 * concurrent additions in one context don't lose each other (the
 * read-modify-write is serialised), against an in-memory storage.session
 * whose reads and writes take a turn of the event loop, like Chrome's.
 */
import type { Entry } from "@holt/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRecentEntry, prependRecent, type RecentEntry } from "./state.js";

const item = (n: number): RecentEntry => ({
  sessionId: "s1",
  entry: { id: `e${n}`, seq: n, kind: "note", note: "x", capturedAt: "t", receivedAt: "t", page: { url: "", title: "" } } as Entry,
});

describe("prependRecent", () => {
  it("puts the new entry first, drops an older copy of it, and caps the list", () => {
    expect(prependRecent([item(1), item(2)], item(3)).map((e) => e.entry.id)).toEqual(["e3", "e1", "e2"]);
    expect(prependRecent([item(1), item(2)], item(2)).map((e) => e.entry.id)).toEqual(["e2", "e1"]);
    const full = Array.from({ length: 30 }, (_, i) => item(i));
    const next = prependRecent(full, item(99));
    expect(next).toHaveLength(30);
    expect(next[0]?.entry.id).toBe("e99");
  });
});

describe("addRecentEntry", () => {
  let session: Record<string, unknown>;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  beforeEach(() => {
    session = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: async (key: string) => {
            await tick();
            return key in session ? { [key]: structuredClone(session[key]) } : {};
          },
          set: async (items: Record<string, unknown>) => {
            await tick();
            Object.assign(session, structuredClone(items));
          },
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("two entries landing at once (a flushed screenshot and a recording's upload) are both listed", async () => {
    await Promise.all([addRecentEntry(item(1)), addRecentEntry(item(2)), addRecentEntry(item(3))]);
    expect((session.recentEntries as RecentEntry[]).map((e) => e.entry.id)).toEqual(["e3", "e2", "e1"]);
  });

  it("a failed write doesn't block the next one", async () => {
    const chromeStub = (globalThis as unknown as { chrome: { storage: { session: { set: unknown } } } }).chrome;
    const set = chromeStub.storage.session.set;
    chromeStub.storage.session.set = async () => {
      throw new Error("quota");
    };
    await expect(addRecentEntry(item(1))).rejects.toThrow("quota");
    chromeStub.storage.session.set = set;
    await addRecentEntry(item(2));
    expect((session.recentEntries as RecentEntry[]).map((e) => e.entry.id)).toEqual(["e2"]);
  });
});
