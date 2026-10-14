import { describe, expect, it } from "vitest";
import { notePageUrl, parseNotePageParams } from "./note-prompt.js";

describe("notePageUrl / parseNotePageParams", () => {
  it("round-trips every mode", () => {
    for (const prompt of [
      { mode: "note", inWindow: false },
      { mode: "note", inWindow: true },
      { mode: "screenshot", id: "6f1c0d7e-1111-4a2b-9c3d-000000000000" },
    ] as const) {
      const url = notePageUrl(prompt);
      expect(url.startsWith("note.html")).toBe(true);
      expect(parseNotePageParams(url.slice("note.html".length))).toEqual(prompt);
    }
  });

  it("encodes the id", () => {
    expect(notePageUrl({ mode: "screenshot", id: "a&b c" })).toBe("note.html?mode=screenshot&id=a%26b%20c");
    expect(parseNotePageParams("?mode=screenshot&id=a%26b%20c")).toEqual({ mode: "screenshot", id: "a&b c" });
  });

  it("falls back to a plain note for a screenshot URL without a usable id", () => {
    expect(parseNotePageParams("?mode=screenshot")).toEqual({ mode: "note", inWindow: false });
    expect(parseNotePageParams("?mode=screenshot&id=")).toEqual({ mode: "note", inWindow: false });
    expect(parseNotePageParams(`?mode=screenshot&id=${"x".repeat(101)}`)).toEqual({ mode: "note", inWindow: false });
    expect(parseNotePageParams("?mode=bogus&id=x&window=1")).toEqual({ mode: "note", inWindow: true });
    expect(parseNotePageParams("")).toEqual({ mode: "note", inWindow: false });
  });
});

describe("parseNotePageParams: hostile or odd URLs", () => {
  it("an id carrying its own parameters is taken literally, not as more parameters", () => {
    const id = "x&mode=note&window=1";
    expect(parseNotePageParams(notePageUrl({ mode: "screenshot", id }).slice("note.html".length))).toEqual({ mode: "screenshot", id });
  });

  it("takes the first of duplicated parameters", () => {
    expect(parseNotePageParams("?mode=screenshot&id=a&id=b")).toEqual({ mode: "screenshot", id: "a" });
    expect(parseNotePageParams("?mode=note&mode=screenshot&id=a")).toEqual({ mode: "note", inWindow: false });
  });

  it("is exact about the mode name", () => {
    expect(parseNotePageParams("?mode=Screenshot&id=a")).toEqual({ mode: "note", inWindow: false });
    expect(parseNotePageParams("?mode=screenshot%20&id=a")).toEqual({ mode: "note", inWindow: false });
  });

  it("accepts an id of exactly 100 characters", () => {
    expect(parseNotePageParams(`?mode=screenshot&id=${"x".repeat(100)}`)).toEqual({ mode: "screenshot", id: "x".repeat(100) });
  });

  it("ignores window=1 in screenshot mode (the prompt is always a window)", () => {
    expect(parseNotePageParams("?mode=screenshot&id=a&window=1")).toEqual({ mode: "screenshot", id: "a" });
  });

  it("tolerates a missing leading ? and unknown parameters", () => {
    expect(parseNotePageParams("mode=screenshot&id=a&utm=1")).toEqual({ mode: "screenshot", id: "a" });
  });
});
