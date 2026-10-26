/**
 * Extension pages (paths inside dist/) that more than one context refers to.
 *
 * The toolbar action's popup is normally the menu (manifest
 * action.default_popup). The quick-note shortcut borrows that slot to show
 * the note page (background/note-popup.ts), and the note page puts the menu
 * back as soon as it loads (note/note.ts). The same note page is also the
 * note prompt after a screenshot (shared/note-prompt.ts has its URLs).
 *
 * The permissions page asks for microphone access in a normal tab; the
 * worker opens it for voice notes, the note prompt for dictation.
 *
 * The welcome page is opened once, in a tab, when holt is first installed
 * (background/index.ts, runtime.onInstalled): what holt needs (the local
 * server), whether it can reach one, the shortcuts, and the transcription
 * setting.
 */
export const MENU_PAGE = "menu.html";
export const NOTE_PAGE = "note.html";
export const PERMISSIONS_PAGE = "permissions.html";
export const WELCOME_PAGE = "welcome.html";

/**
 * Open the welcome page (welcome.html) for this runtime.onInstalled reason?
 * Only on a fresh install: the store installing holt, or loading it
 * unpacked into a profile that never had it. Not on "update" (every new
 * version, and every reload of an unpacked build), "chrome_update" or
 * "shared_module_update": someone who already uses holt doesn't need the
 * introduction again. Pure, unit-tested.
 */
export function opensWelcomeOn(reason: string): boolean {
  return reason === "install";
}

/**
 * Is `url` one of our own extension pages (the note prompt or note window,
 * the permissions page)? Keyboard commands pressed while one of them is in
 * front are retargeted to the page the user is working on
 * (background/commands.ts). The worker can read the URL of its own pages'
 * tabs without the "tabs" permission. Pure, unit-tested.
 */
export function isOwnExtensionPage(url: string | undefined, runtimeId: string): boolean {
  return Boolean(url && runtimeId) && (url as string).startsWith(`chrome-extension://${runtimeId}/`);
}
