/**
 * permissions.html: ask for microphone access in a normal tab (see the HTML
 * comment for why). We only need the prompt; the stream is stopped at once.
 * Granting also makes microphone names visible to the panel's picker.
 * The transcription switch (what goes to Google's speech service, and how
 * to turn it off) is shown under it, see sidepanel/ui/transcription.ts.
 */

import { loadSettings } from "../shared/settings.js";
import { transcribeToggle } from "../sidepanel/ui/transcription.js";

const button = document.getElementById("grant") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLElement;

button.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    result.textContent = "Microphone access granted. You can close this tab and start the voice note again (its shortcut or the toolbar menu).";
    button.disabled = true;
  } catch (error) {
    const name = (error as DOMException).name;
    result.textContent =
      name === "NotAllowedError"
        ? `Access was denied. To change it, open chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)} and allow the microphone.`
        : `Could not access the microphone: ${(error as Error).message}`;
  }
});

void loadSettings().then(({ transcribe }) => {
  document.getElementById("transcription")?.append(transcribeToggle({ initial: transcribe }));
});
