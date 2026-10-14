import { describe, expect, it } from "vitest";
import { describeMicrophoneError, describeSpeechError, microphoneProblem, type SpeechUse } from "./speech-errors.js";

const USES: SpeechUse[] = ["dictation", "narration", "voice-note"];
const dom = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("microphoneProblem", () => {
  it("classifies getUserMedia's errors by name, from the error or the bare name", () => {
    expect(microphoneProblem(dom("NotAllowedError"))).toBe("blocked");
    expect(microphoneProblem(dom("SecurityError"))).toBe("blocked");
    expect(microphoneProblem("NotAllowedError")).toBe("blocked");
    expect(microphoneProblem(dom("NotFoundError"))).toBe("missing");
    expect(microphoneProblem({ name: "NotFoundError", message: "x" })).toBe("missing");
    expect(microphoneProblem(dom("NotReadableError"))).toBe("other");
    expect(microphoneProblem(undefined)).toBe("other");
    expect(microphoneProblem(null)).toBe("other");
  });
});

describe("describeMicrophoneError", () => {
  it("blocked: every use points at the fix, and the recorders say what still happens", () => {
    expect(describeMicrophoneError(dom("NotAllowedError"), "dictation")).toMatch(/blocked.*page that just opened/);
    expect(describeMicrophoneError(dom("NotAllowedError"), "narration")).toMatch(/no transcript.*The recording continues\.$/);
    expect(describeMicrophoneError({ name: "SecurityError", message: "" }, "voice-note")).toMatch(/blocked.*permission page/);
  });

  it("missing", () => {
    expect(describeMicrophoneError(dom("NotFoundError"), "dictation")).toBe("No microphone found. Type your note instead.");
    expect(describeMicrophoneError(dom("NotFoundError"), "narration")).toMatch(/^No microphone found, so there is no transcript/);
    expect(describeMicrophoneError("NotFoundError", "voice-note")).toBe("No microphone found.");
  });

  it("anything else carries the browser's message", () => {
    expect(describeMicrophoneError(dom("NotReadableError", "Device in use"), "dictation")).toBe("Could not start dictation: Device in use");
    expect(describeMicrophoneError(dom("AbortError", "gone"), "narration")).toBe("No transcript: the microphone could not be opened (gone). The recording continues.");
    expect(describeMicrophoneError({ name: "Weird", message: "odd" }, "voice-note")).toBe("Could not start the voice note: odd");
    expect(describeMicrophoneError("plain text", "voice-note")).toBe("Could not start the voice note: plain text");
    expect(describeMicrophoneError(42, "dictation")).toBe("Could not start dictation: 42");
  });
});

describe("describeSpeechError", () => {
  it("not-allowed / network: the recorders keep recording, dictation keeps the text", () => {
    for (const code of ["not-allowed", "service-not-allowed"]) {
      expect(describeSpeechError(code, "dictation")).toMatch(/not allowed here.*Type your note instead/);
      expect(describeSpeechError(code, "narration")).toMatch(/Still recording, without a transcript/);
      expect(describeSpeechError(code, "voice-note")).toMatch(/Still recording, without a transcript/);
    }
    expect(describeSpeechError("network", "dictation")).toMatch(/^Dictation needs a network connection/);
    expect(describeSpeechError("network", "narration")).toMatch(/Still recording/);
  });

  it("the rest is the same everywhere", () => {
    for (const use of USES) {
      expect(describeSpeechError("audio-capture", use)).toBe("Speech recognition could not access the microphone.");
      expect(describeSpeechError("language-not-supported", use)).toBe("Speech recognition error: language-not-supported.");
    }
  });
});
