/**
 * The page the user is looking at, for the `page` field of panel-created
 * entries (notes, recordings, voice notes).
 *
 * The side panel is not a tab, so we ask for the active tab of the panel's
 * window. Without the "tabs" permission, url/title are only available for
 * tabs we have access to; see shared/page-context.ts.
 */

import type { PageContext } from "@nitpick/protocol";
import { pageContextFromTab } from "../shared/page-context.js";
import { getState } from "./store.js";

export async function getActivePage(): Promise<PageContext> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: getState().windowId });
    return pageContextFromTab(tab);
  } catch {
    return pageContextFromTab(undefined);
  }
}
