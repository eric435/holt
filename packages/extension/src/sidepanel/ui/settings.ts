/**
 * Settings (collapsible): how to find the server (auto-detect from the page
 * or always one URL), the server URL (the fallback, or the one URL), token,
 * keep-audio toggle (saved with the Save button), the microphone picker
 * (saved as soon as it changes), and the current keyboard shortcuts.
 * Validation lives in shared/settings.ts so it is unit-tested.
 */

import { errorMessage } from "../../shared/messages.js";
import { DEFAULT_SERVER_URL, saveSettings, validateServerUrl, type ServerMode } from "../../shared/settings.js";
import { getState, update } from "../store.js";
import { h, replace } from "./dom.js";
import { microphonePicker } from "./microphone.js";
import { openShortcutsPage, shortcutList } from "./shortcuts.js";
import { refreshStatus } from "./status.js";
import { toast } from "./toast.js";

export function mountSettings(root: HTMLElement): void {
  const { settings } = getState();
  const modeInput = (mode: ServerMode): HTMLInputElement =>
    h("input", { type: "radio", name: "server-mode", value: mode, checked: settings.serverMode === mode });
  const autoMode = modeInput("auto");
  const fixedMode = modeInput("fixed");
  const urlLabel = h("span", {});
  const urlInput = h("input", { type: "url", value: settings.serverUrl, placeholder: DEFAULT_SERVER_URL, spellcheck: "false" });
  const urlHint = h("div", { class: "hint" });
  const tokenInput = h("input", { type: "password", value: settings.token, autocomplete: "off", placeholder: "(none)" });
  const keepAudio = h("input", { type: "checkbox", checked: settings.keepAudio });
  const save = h("button", { type: "submit" }, "Save");

  const validate = (): boolean => {
    const auto = autoMode.checked;
    urlLabel.textContent = auto ? "Fallback server URL" : "Server URL";
    const result = validateServerUrl(urlInput.value);
    urlHint.className = result.ok ? (result.warning ? "hint warn" : "hint") : "hint error-text";
    urlHint.textContent = result.ok
      ? (result.warning ??
        (auto
          ? "Used on pages that don't serve holt themselves: the standalone server (npx @velvet-thunder/holt, http://127.0.0.1:4848), or a Vite dev server behind another backend."
          : "Standalone: http://127.0.0.1:4848 · Vite plugin: your dev server's URL"))
      : result.error;
    return result.ok;
  };
  urlInput.addEventListener("input", validate);
  autoMode.addEventListener("change", validate);
  fixedMode.addEventListener("change", validate);
  validate();

  const form = h(
    "form",
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!validate()) return;
        try {
          const next = await saveSettings({
            serverMode: fixedMode.checked ? "fixed" : "auto",
            serverUrl: urlInput.value,
            token: tokenInput.value,
            keepAudio: keepAudio.checked,
          });
          urlInput.value = next.serverUrl;
          update({ settings: next, server: { kind: "checking" } });
          toast("success", "Settings saved.");
          void refreshStatus();
        } catch (error) {
          toast("error", errorMessage(error));
        }
      },
    },
    h(
      "fieldset",
      { class: "server-mode" },
      h("legend", {}, "Server"),
      h("label", { class: "check" }, autoMode, "Auto-detect from the page (falls back to the URL below)"),
      h("label", { class: "check" }, fixedMode, "Always use this URL"),
    ),
    h("label", {}, urlLabel, urlInput),
    urlHint,
    h("label", {}, "Token", tokenInput),
    h("div", { class: "hint" }, "Only if holt.config.json sets a token. Stored on this device only (not synced)."),
    h("label", { class: "check" }, keepAudio, "Also keep the audio of voice notes"),
    h(
      "div",
      { class: "hint" },
      "Off: only your reviewed words are saved. The audio is always kept when nothing was recognised.",
    ),
    h("div", { class: "row end" }, save),
  );

  const about = h(
    "p",
    { class: "hint" },
    `holt extension ${__HOLT_VERSION__} · origin `,
    h("code", {}, location.origin),
    " · shortcuts: ",
    h("a", { href: "#", onclick: openShortcutsPage }, "chrome://extensions/shortcuts"),
  );

  replace(root, h("details", {}, h("summary", {}, "Settings"), form, microphonePicker(), shortcutList(), about));
}
