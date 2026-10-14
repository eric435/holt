/**
 * Paths of the on-demand content scripts (relative to dist/) and a helper to
 * inject them.
 *
 * They are injected with chrome.scripting.executeScript({ files }) instead of
 * being declared under "content_scripts" in the manifest: declaring them
 * would need host permissions for every site and would run them on every
 * page load. Injection only works on tabs we have access to (activeTab grant
 * or our localhost host_permissions).
 *
 * Files injected this way are classic scripts, not ES modules, which is why
 * the build emits them as IIFE bundles.
 */

export const AREA_SELECT_FILE = "content/area-select.js";
export const PAGE_HELPER_FILE = "content/page-helper.js";
export const VOICE_OVERLAY_FILE = "content/voice-overlay.js";

export async function injectFile(tabId: number, file: string): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
}
