/**
 * The side panel's entry list and notes.md (server/src/session/markdown.ts)
 * are separate code in separate packages but show the same durations, so
 * this compares them directly. If one changes without the other, this fails.
 */
import { describe, expect, it } from "vitest";
import { formatDuration as serverDuration } from "../../../server/src/session/markdown.js";
import { formatDuration } from "./entry-view.js";

describe("side panel entry list vs notes.md", () => {
  it.each([0, 400, 499, 500, 12_400, 59_499, 59_500, 65_000, 3_599_500, 3_600_000, 3_723_000, 36_000_000, -5_000])(
    "formats %d ms the same way",
    (ms) => {
      expect(formatDuration(ms)).toBe(serverDuration(ms));
    },
  );
});
