/**
 * Keyboard shortcuts in the panel: the one-time "set the rest" hint in the
 * Capture card, and the list of current bindings under Settings.
 *
 * Bindings come from chrome.commands.getAll() (store.shortcuts, refreshed
 * whenever the panel becomes visible again, since the user may just have
 * changed them at chrome://extensions/shortcuts), never from the manifest.
 * See shared/shortcuts.ts for why.
 */

import { saveSettings } from "../../shared/settings.js";
import { COMMAND_LABELS, SHORTCUTS_PAGE, getShortcuts, unboundHint } from "../../shared/shortcuts.js";
import { subscribe, update } from "../store.js";
import { h, replace } from "./dom.js";

const isMac = navigator.platform.toLowerCase().includes("mac");

/** Load the current bindings into the store. */
export async function refreshShortcuts(): Promise<void> {
  update({ shortcuts: await getShortcuts() });
}

/** Extension pages may open chrome:// URLs as tabs (links to them are blocked). */
export function openShortcutsPage(e?: Event): void {
  e?.preventDefault();
  void chrome.tabs.create({ url: SHORTCUTS_PAGE });
}

/**
 * "Tip: Set Alt+W (full-page screenshot) and Alt+T (text note) at
 * chrome://extensions/shortcuts". Shown while those commands are unbound,
 * until dismissed (remembered in settings).
 */
export function mountShortcutHint(root: HTMLElement): void {
  let shown: [unknown, unknown] = [null, null];
  subscribe(({ shortcuts, settings }) => {
    if (shortcuts === shown[0] && settings === shown[1]) return;
    shown = [shortcuts, settings];
    const text = Object.keys(shortcuts).length > 0 ? unboundHint(shortcuts, isMac) : null;
    if (!text || settings.hideShortcutHint) return replace(root);
    replace(
      root,
      h(
        "div",
        { class: "shortcut-hint" },
        h("span", {}, "Tip: ", h("a", { href: "#", onclick: openShortcutsPage }, text)),
        h(
          "button",
          {
            class: "toast-close",
            "aria-label": "Dismiss this tip",
            title: "Don't show again",
            onclick: () => void saveSettings({ hideShortcutHint: true }).then((next) => update({ settings: next })),
          },
          "×",
        ),
      ),
    );
  });
}

/** The Settings section's list: "Screenshot: visible area   Alt+S". */
export function shortcutList(): HTMLElement {
  const list = h("dl", { class: "shortcuts" });
  let shown: unknown = null;
  subscribe(({ shortcuts }) => {
    if (shortcuts === shown) return;
    shown = shortcuts;
    replace(
      list,
      ...COMMAND_LABELS.flatMap(([name, label]) => [
        h("dt", {}, label),
        h("dd", {}, shortcuts[name] ? h("kbd", {}, shortcuts[name]) : h("span", { class: "muted" }, "not set")),
      ]),
    );
  });
  return h(
    "div",
    {},
    h("h3", {}, "Shortcuts"),
    list,
    h("p", { class: "hint" }, "Change them at ", h("a", { href: "#", onclick: openShortcutsPage }, SHORTCUTS_PAGE), "."),
  );
}
