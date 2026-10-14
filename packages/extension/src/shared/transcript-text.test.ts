import { describe, expect, it } from "vitest";
import { appendSpeech, applyFinal, mergeTranscript, newSpeech, type SpeechField } from "./transcript-text.js";

describe("newSpeech", () => {
  it("returns what was recognised after `heard`", () => {
    expect(newSpeech("the menu", "the menu flickers")).toBe("flickers");
    expect(newSpeech("", "hello")).toBe("hello");
  });

  it("is empty when nothing new was recognised", () => {
    expect(newSpeech("same", "same")).toBe("");
  });

  it("is null when `final` does not extend `heard`", () => {
    expect(newSpeech("the menu", "a different text")).toBeNull();
  });
});

describe("appendSpeech", () => {
  it("separates with a space", () => {
    expect(appendSpeech("the menu", "flickers")).toBe("the menu flickers");
  });

  it("adds no space to empty text or text ending in whitespace", () => {
    expect(appendSpeech("", "hello")).toBe("hello");
    expect(appendSpeech("first line\n", "second")).toBe("first line\nsecond");
    expect(appendSpeech("ends with space ", "x")).toBe("ends with space x");
  });

  it("leaves the text alone when there is nothing to add", () => {
    expect(appendSpeech("as typed", "")).toBe("as typed");
  });
});

describe("mergeTranscript", () => {
  it("keeps the user's edits and appends later speech", () => {
    // The user fixed "flicker" -> "flickers" after hearing "the menu flicker",
    // then said "on hover".
    expect(mergeTranscript({ text: "The menu flickers.", heard: "the menu flicker" }, "the menu flicker on hover")).toBe("The menu flickers. on hover");
  });

  it("keeps the user's text if the recogniser's text no longer matches", () => {
    expect(mergeTranscript({ text: "mine", heard: "abc" }, "xyz")).toBe("mine");
  });

  it("an emptied draft stays empty until more is said", () => {
    expect(mergeTranscript({ text: "", heard: "noise" }, "noise")).toBe("");
    expect(mergeTranscript({ text: "", heard: "noise" }, "noise real words")).toBe("real words");
  });
});

/**
 * The way the transcript box and the note prompt use these functions: after
 * every recogniser update, merge it into the user's text and remember it as
 * `heard`. Whatever the user does in between, nothing recognised may be
 * lost or appear twice.
 */
describe("a dictation session (merge, then heard = final, repeatedly)", () => {
  type Step = { final: string } | { edit: (text: string) => string };

  function run(steps: Step[]): string {
    let draft = { text: "", heard: "" };
    for (const step of steps) {
      if ("final" in step) draft = { text: mergeTranscript(draft, step.final), heard: step.final };
      else draft = { ...draft, text: step.edit(draft.text) };
    }
    return draft.text;
  }

  it("without edits, the text is what was recognised", () => {
    expect(run([{ final: "the menu" }, { final: "the menu flickers" }, { final: "the menu flickers on hover" }])).toBe(
      "the menu flickers on hover",
    );
  });

  it("repeated identical updates (interim churn, re-sent finals) add nothing", () => {
    expect(run([{ final: "one" }, { final: "one" }, { final: "one" }, { final: "one two" }, { final: "one two" }])).toBe("one two");
  });

  it("edits in the middle survive later speech, which is appended once", () => {
    expect(
      run([
        { final: "the menu flicker" },
        { edit: (t) => t.replace("flicker", "flickers.") },
        { final: "the menu flicker on hover" },
        { edit: (t) => `Bug: ${t}` },
        { final: "the menu flicker on hover in Safari" },
      ]),
    ).toBe("Bug: the menu flickers. on hover in Safari");
  });

  it("text the user deleted stays deleted", () => {
    expect(run([{ final: "um so" }, { edit: () => "" }, { final: "um so the button" }])).toBe("the button");
  });

  it("text typed before any speech is kept in front of it", () => {
    expect(run([{ edit: () => "Typed:" }, { final: "spoken" }])).toBe("Typed: spoken");
  });

  it("recogniser whitespace at the joins does not double up spaces", () => {
    expect(run([{ final: "first " }, { final: "first  second" }, { final: "first  second\tthird" }])).toBe("first second third");
  });

  it("a recogniser that rewrites what it already said leaves the user's text alone, and later speech still arrives", () => {
    // The worker / box set heard = final even when it did not extend, so
    // the next extension of the *new* text is appended.
    expect(run([{ final: "the men you" }, { final: "the menu" }, { final: "the menu is broken" }])).toBe("the men you is broken");
  });
});

/** A textarea stand-in: value, selection and setRangeText as the DOM does them. */
function field(value: string, caret: number = value.length, selectionEnd: number = caret): SpeechField & { selectionStart: number; selectionEnd: number } {
  const f = {
    value,
    selectionStart: caret,
    selectionEnd,
    scrollTop: 0,
    scrollHeight: 500,
    setRangeText(replacement: string, start: number, end: number, mode: "end" | "preserve") {
      f.value = f.value.slice(0, start) + replacement + f.value.slice(end);
      if (mode === "end") f.selectionStart = f.selectionEnd = start + replacement.length;
    },
  };
  return f;
}

describe("applyFinal", () => {
  const typing = { edited: true, focused: true };

  it("appends the new words and moves a caret that was at the end past them", () => {
    const f = field("The menu");
    expect(applyFinal(f, "", "flickers", typing)).toBe("flickers");
    expect(f.value).toBe("The menu flickers");
    expect(f.selectionStart).toBe(f.value.length);
    expect(f.scrollTop).toBe(500);
  });

  it("leaves a caret (or selection) elsewhere where the user put it, and doesn't scroll away from it", () => {
    const f = field("The menu", 3, 5);
    applyFinal(f, "", "flickers", typing);
    expect(f.value).toBe("The menu flickers");
    expect([f.selectionStart, f.selectionEnd]).toEqual([3, 5]);
    expect(f.scrollTop).toBe(0);
  });

  it("scrolls to the new words when the field isn't focused, wherever the caret is", () => {
    const f = field("abc", 0);
    applyFinal(f, "", "def", { edited: true, focused: false });
    expect(f.scrollTop).toBe(500);
  });

  it("only appends what is new since `heard`; nothing new changes nothing", () => {
    const f = field("the menu (edited)");
    expect(applyFinal(f, "the menu", "the menu flickers", typing)).toBe("the menu flickers");
    expect(f.value).toBe("the menu (edited) flickers");
    const unchanged = field("same");
    expect(applyFinal(unchanged, "x", "x", typing)).toBe("x");
    expect(unchanged.value).toBe("same");
  });

  it("a final that doesn't extend `heard` replaces untouched text, keeps the user's, and becomes `heard` either way", () => {
    const untouched = field("old words");
    expect(applyFinal(untouched, "old words", "new words", { edited: false, focused: false })).toBe("new words");
    expect(untouched.value).toBe("new words");

    const mine = field("my note");
    expect(applyFinal(mine, "old words", "new words", typing)).toBe("new words");
    expect(mine.value).toBe("my note");
    // ... so what comes next is appended rather than lost.
    applyFinal(mine, "new words", "new words and more", typing);
    expect(mine.value).toBe("my note and more");
  });
});
