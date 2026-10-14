/**
 * Microphone picker (in Settings: it is a set-once preference; while a
 * voice note runs, the toolbar icon's tooltip names the microphone in use).
 *
 * Devices come from navigator.mediaDevices.enumerateDevices(). Chrome hides
 * details until the extension's origin has microphone permission: before
 * that it returns at most one "audioinput" with an empty deviceId and label,
 * so there is nothing to pick yet, and we show a "Grant access to see
 * names" button that opens permissions.html (the prompt can't be shown in
 * the panel reliably, or ever in the offscreen recorder). Devices with an
 * id but no label are shown as "Microphone 1", "Microphone 2".
 *
 * The list is refreshed on `devicechange` (plug/unplug) and when the
 * microphone permission changes (granting it in permissions.html reveals
 * the names).
 *
 * The id we store is the panel's deviceId; the offscreen recorder has the
 * same origin, so the same id refers to the same device there. Chrome's
 * "default" pseudo-device is offered as "System default" (stored as "").
 */

import { errorMessage } from "../../shared/messages.js";
import { saveSettings } from "../../shared/settings.js";
import { getState, update } from "../store.js";
import { h, replace } from "./dom.js";
import { toast } from "./toast.js";

export function microphonePicker(): HTMLElement {
  const select = h("select", { "aria-label": "Microphone for voice notes" });
  const grant = h("button", { type: "button", class: "link", hidden: true, onclick: openPermissionsPage }, "Grant access to see names");
  const status = h("div", { class: "hint" });

  async function refresh(): Promise<void> {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    } catch {
      /* no media devices API: leave the default only */
    }
    const { microphoneId, microphoneLabel } = getState().settings;
    const real = devices.filter((d) => d.deviceId && d.deviceId !== "default");
    const options = [h("option", { value: "" }, "System default")];
    real.forEach((d, i) => options.push(h("option", { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
    if (microphoneId && !real.some((d) => d.deviceId === microphoneId)) {
      // Unplugged, or not visible yet: keep it selectable so we don't silently forget the choice.
      options.push(h("option", { value: microphoneId }, `${microphoneLabel || "Selected microphone"} (not found)`));
    }
    replace(select, ...options);
    select.value = microphoneId;

    const named = real.some((d) => d.label);
    grant.hidden = named;
    status.textContent = named
      ? "Used for voice notes. On recent Chrome the transcript comes from this microphone too; older versions transcribe from the system default."
      : "Chrome shows microphone names only after holt has microphone access.";
  }

  select.addEventListener("change", () => {
    const option = select.selectedOptions[0];
    // Only remember a label Chrome gave us (not "Microphone 2" or "(not found)").
    const label = option && !/^Microphone \d+$| \(not found\)$/.test(option.text) && option.value ? option.text : "";
    saveSettings({ microphoneId: select.value, microphoneLabel: label })
      .then((next) => update({ settings: next }))
      .catch((error: unknown) => toast("error", errorMessage(error)));
  });

  navigator.mediaDevices?.addEventListener("devicechange", () => void refresh());
  navigator.permissions
    ?.query({ name: "microphone" as PermissionName })
    .then((permission) => permission.addEventListener("change", () => void refresh()))
    .catch(() => undefined);
  void refresh();

  return h("div", { class: "mic-picker" }, h("label", {}, "Microphone", select), h("div", { class: "row" }, grant), status);
}

export function openPermissionsPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
}
