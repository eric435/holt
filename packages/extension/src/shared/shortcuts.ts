/**
 * Keyboard shortcuts as the user actually has them, for tooltips, the
 * toolbar tooltip and the panel's "Shortcuts" list.
 *
 * The manifest only *suggests* keys. Chrome honours at most four suggested
 * keys per extension (more is a manifest load error), silently skips one
 * that another extension already uses, and the user can rebind anything at
 * chrome://extensions/shortcuts. So the UI never hard-codes "Alt+S": it asks
 * `chrome.commands.getAll()`, whose `shortcut` is the current binding as
 * Chrome displays it ("" if unbound; on macOS Chrome renders it with
 * symbols, e.g. "⌥S").
 *
 * Everything except `getShortcuts` is pure and unit-tested.
 */

/** Our command names (manifest.json "commands"). */
export type CommandName =
  | "open-panel"
  | "screenshot-viewport"
  | "screenshot-full"
  | "screenshot-area"
  | "toggle-recording"
  | "toggle-voice"
  | "quick-note";

/** Shown in the panel's Shortcuts list, in this order. */
export const COMMAND_LABELS: ReadonlyArray<readonly [CommandName, string]> = [
  ["screenshot-viewport", "Screenshot: visible area"],
  ["screenshot-full", "Screenshot: full page"],
  ["screenshot-area", "Screenshot: select area"],
  ["toggle-recording", "Start/stop tab recording"],
  ["toggle-voice", "Start/stop voice note"],
  ["quick-note", "Text note"],
  ["open-panel", "Open the side panel"],
];

/**
 * Commands that ship without a default key (the four slots are taken), and
 * the key we suggest the user assign. Shown as a one-time hint.
 */
export const SUGGESTED_UNBOUND: ReadonlyArray<readonly [CommandName, string, string]> = [
  ["screenshot-full", "W", "full-page screenshot"],
  ["quick-note", "T", "text note"],
];

/** command name -> current shortcut ("" = unbound). */
export type ShortcutMap = Readonly<Partial<Record<string, string>>>;

/** The subset of chrome.commands.Command we read. */
export interface CommandLike {
  name?: string | undefined;
  shortcut?: string | undefined;
}

export function shortcutMap(commands: readonly CommandLike[]): ShortcutMap {
  const map: Record<string, string> = {};
  for (const c of commands) if (c.name) map[c.name] = c.shortcut ?? "";
  return map;
}

/** "Visible (Alt+S)" when bound, plain "Visible" otherwise. */
export function withShortcut(text: string, shortcuts: ShortcutMap, command: CommandName): string {
  const key = shortcuts[command];
  return key ? `${text} (${key})` : text;
}

/** "Alt+W" or, on macOS, "⌥W" (how Chrome shows Option there). */
export function altKeyLabel(letter: string, isMac: boolean): string {
  return isMac ? `⌥${letter}` : `Alt+${letter}`;
}

/**
 * The hint for commands that still have no key, e.g.
 * "Set Alt+W (full-page screenshot) and Alt+T (text note) at chrome://extensions/shortcuts",
 * or null when they are all bound.
 */
export function unboundHint(shortcuts: ShortcutMap, isMac: boolean): string | null {
  const missing = SUGGESTED_UNBOUND.filter(([name]) => !shortcuts[name]).map(
    ([, letter, what]) => `${altKeyLabel(letter, isMac)} (${what})`,
  );
  if (missing.length === 0) return null;
  return `Set ${missing.join(" and ")} at chrome://extensions/shortcuts`;
}

/** Current bindings. Available in the worker and in extension pages. */
export async function getShortcuts(): Promise<ShortcutMap> {
  try {
    return shortcutMap(await chrome.commands.getAll());
  } catch {
    return {};
  }
}

export const SHORTCUTS_PAGE = "chrome://extensions/shortcuts";
