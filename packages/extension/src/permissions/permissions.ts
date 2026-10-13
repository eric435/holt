/**
 * permissions.html: ask for microphone access in a normal tab (see the HTML
 * comment for why). We only need the prompt; the stream is stopped at once.
 */

const button = document.getElementById("grant") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLElement;

button.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    result.textContent = "Microphone access granted. You can close this tab and record voice notes from the side panel.";
    button.disabled = true;
  } catch (error) {
    const name = (error as DOMException).name;
    result.textContent =
      name === "NotAllowedError"
        ? `Access was denied. To change it, open chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)} and allow the microphone.`
        : `Could not access the microphone: ${(error as Error).message}`;
  }
});
