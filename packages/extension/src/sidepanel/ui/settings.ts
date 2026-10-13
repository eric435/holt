/**
 * Settings (collapsible): server URL, token, keep-audio toggle.
 * Validation lives in shared/settings.ts so it is unit-tested.
 */

import { errorMessage } from "../../shared/messages.js";
import { DEFAULT_SERVER_URL, saveSettings, validateServerUrl } from "../../shared/settings.js";
import { getState, update } from "../store.js";
import { h, replace } from "./dom.js";
import { refreshStatus } from "./status.js";
import { toast } from "./toast.js";

export function mountSettings(root: HTMLElement): void {
  const { settings } = getState();
  const urlInput = h("input", { type: "url", value: settings.serverUrl, placeholder: DEFAULT_SERVER_URL, spellcheck: "false" });
  const urlHint = h("div", { class: "hint" });
  const tokenInput = h("input", { type: "password", value: settings.token, autocomplete: "off", placeholder: "(none)" });
  const keepAudio = h("input", { type: "checkbox", checked: settings.keepAudio });
  const save = h("button", { type: "submit" }, "Save");

  const validate = (): boolean => {
    const result = validateServerUrl(urlInput.value);
    urlHint.className = result.ok ? (result.warning ? "hint warn" : "hint") : "hint error-text";
    urlHint.textContent = result.ok
      ? (result.warning ?? "Standalone: http://127.0.0.1:4848 · Vite plugin: your dev server's URL")
      : result.error;
    return result.ok;
  };
  urlInput.addEventListener("input", validate);
  validate();

  const form = h(
    "form",
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!validate()) return;
        try {
          const next = await saveSettings({ serverUrl: urlInput.value, token: tokenInput.value, keepAudio: keepAudio.checked });
          urlInput.value = next.serverUrl;
          update({ settings: next, server: { kind: "checking" } });
          toast("success", "Settings saved.");
          void refreshStatus();
        } catch (error) {
          toast("error", errorMessage(error));
        }
      },
    },
    h("label", {}, "Server URL", urlInput),
    urlHint,
    h("label", {}, "Token", tokenInput),
    h("div", { class: "hint" }, "Only if nitpick.config.json sets a token. Stored on this device only (not synced)."),
    h("label", { class: "check" }, keepAudio, "Keep audio of voice notes (not just the transcript)"),
    h("div", { class: "row end" }, save),
  );

  const about = h(
    "p",
    { class: "hint" },
    `nitpick extension ${__NITPICK_VERSION__} · origin `,
    h("code", {}, location.origin),
    " · shortcuts: ",
    h("a", { href: "#", onclick: openShortcuts }, "chrome://extensions/shortcuts"),
  );

  replace(root, h("details", {}, h("summary", {}, "Settings"), form, about));
}

function openShortcuts(e: Event): void {
  e.preventDefault();
  // Links to chrome:// URLs are blocked from pages, but extensions may open them as tabs.
  void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
}
