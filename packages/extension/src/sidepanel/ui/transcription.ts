/**
 * The "Transcribe speech" switch and what it means, in one place: shown in
 * the side panel's Settings, on the microphone permission page and on the
 * welcome page (all extension pages; this module only needs dom.ts and the
 * settings, so the other pages can use it too).
 *
 * What it discloses: holt's live transcripts come from Chrome's speech
 * recognition (webkitSpeechRecognition, shared/speech.ts), which in Chrome
 * sends the microphone audio to Google's speech service while it listens:
 * during a voice note, during a tab recording (the narration), and while
 * dictating in the note window. holt's own uploads only go to the holt
 * server. With the switch off no recogniser is ever created
 * (Settings.transcribe has the details of what still works).
 *
 * It saves as soon as it is flipped, unlike the panel's Save button: it is
 * a privacy choice, and one that is shown but not saved would be worse
 * than none. It also follows changes made on another of these pages
 * (storage.onChanged), so two open pages never disagree.
 */

import { errorMessage } from "../../shared/messages.js";
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from "../../shared/settings.js";
import { h } from "./dom.js";

export const TRANSCRIBE_LABEL = "Transcribe speech (uses Chrome's speech recognition, which sends audio to Google)";

export const TRANSCRIBE_DISCLOSURE =
  "While this is on, Chrome sends your microphone audio to Google's speech service whenever holt transcribes: " +
  "during a voice note, during a tab recording (your narration), and while you dictate in the note window. " +
  "holt itself sends recordings only to your holt server. " +
  "Turn it off to keep all audio on your machine: voice notes then save their audio file instead of a transcript, " +
  "tab recordings don't use the microphone, and dictation is hidden.";

export interface TranscribeToggleOptions {
  /** The current value (the page has usually loaded the settings already). */
  initial: boolean;
  /** After a change was saved here or arrived from another page. */
  onChange?: (settings: Settings) => void;
}

export function transcribeToggle({ initial, onChange }: TranscribeToggleOptions): HTMLElement {
  const input = h("input", { type: "checkbox", checked: initial });
  const status = h("div", { class: "hint", role: "status" });

  input.addEventListener("change", () => {
    const wanted = input.checked;
    input.disabled = true;
    saveSettings({ transcribe: wanted })
      .then((next) => {
        status.className = "hint";
        status.textContent = next.transcribe ? "Saved: speech is transcribed." : "Saved: speech is not transcribed, nothing is sent to Google.";
        onChange?.(next);
      })
      .catch((error: unknown) => {
        input.checked = !wanted;
        status.className = "hint error-text";
        status.textContent = `Not saved: ${errorMessage(error)}`;
      })
      .finally(() => (input.disabled = false));
  });

  onSettingsChanged(() => {
    void loadSettings().then((next) => {
      if (input.checked === next.transcribe) return;
      input.checked = next.transcribe;
      onChange?.(next);
    });
  });

  return h(
    "div",
    { class: "transcribe-setting" },
    h("label", { class: "check" }, input, TRANSCRIBE_LABEL),
    h("div", { class: "hint" }, TRANSCRIBE_DISCLOSURE),
    status,
  );
}
