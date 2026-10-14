/**
 * The toolbar icon as a status indicator. This module is the only place
 * that writes the action's badge, title and icon, so the recording
 * indicator and the short "✓"/"!" flashes (notify.ts) don't fight:
 *
 *   refreshIndicator()  recompute from storage (recording state, current
 *                       shortcuts, server for the page in front) and apply. Called whenever
 *                       the recording state or server info changes, in
 *                       whatever context changed it (via storage.onChanged,
 *                       see index.ts), and on worker start.
 *   flashBadge()        show "✓"/"!" for a moment, then refreshIndicator(),
 *                       which puts "REC"/"MIC" (or the "no server" "!")
 *                       back, or clears the badge.
 *
 * The decision itself (text, colour, tooltip) is the pure `indicatorFor`
 * in indicator-model.ts.
 *
 * Red-dot icon: drawn once per worker instance with OffscreenCanvas (which
 * service workers have; a <canvas> needs a document) from our own PNGs and
 * set with chrome.action.setIcon({ imageData }). The dot is drawn top-right
 * because Chrome draws the badge bottom-right, so it stays visible while the
 * badge is flashing.
 */

import { getState, getRecordingState } from "../shared/state.js";
import { getShortcuts } from "../shared/shortcuts.js";
import { indicatorFor } from "./indicator-model.js";

const DEFAULT_ICON = chrome.runtime.getManifest().action?.default_icon as Record<string, string> | undefined;
const ICON_SIZES = [16, 32] as const;

/** While a flash is showing (epoch ms), refreshes leave badge text/colour/title alone. */
let flashingUntil = 0;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
/** Last icon we set, to skip redundant setIcon calls (they make the icon flicker). */
let iconIsRecording: boolean | null = null;
let recordingIcon: Promise<Record<number, ImageData>> | null = null;

export async function refreshIndicator(): Promise<void> {
  try {
    const [recording, shortcuts, serverInfo] = await Promise.all([getRecordingState(), getShortcuts(), getState("serverInfo")]);
    const indicator = indicatorFor({ recording, shortcuts, server: serverInfo });
    const work: Promise<unknown>[] = [setIcon(indicator.recording)];
    if (Date.now() >= flashingUntil) {
      work.push(
        chrome.action.setBadgeBackgroundColor({ color: indicator.color }),
        chrome.action.setBadgeText({ text: indicator.text }),
        chrome.action.setTitle({ title: indicator.title }),
      );
    }
    await Promise.all(work);
  } catch (error) {
    console.warn("[holt] could not update the toolbar indicator", error);
  }
}

/**
 * Show `text` on the badge for a moment (with `title` as the tooltip, if
 * given), then restore the indicator.
 *
 * The timer is a plain setTimeout. That is safe here: we were just doing
 * work, and an MV3 worker lives ~30 s after its last event, far longer than
 * the flash. (If it were killed anyway, the next refreshIndicator, e.g. on
 * the next worker start, fixes the badge.)
 */
export async function flashBadge(text: string, color: string, title?: string): Promise<void> {
  const ms = title ? 7_500 : 2_500;
  flashingUntil = Date.now() + ms;
  clearTimeout(flashTimer);
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (title) await chrome.action.setTitle({ title });
  flashTimer = setTimeout(() => {
    flashingUntil = 0;
    void refreshIndicator();
  }, ms);
}

async function setIcon(recording: boolean): Promise<void> {
  if (iconIsRecording === recording) return;
  iconIsRecording = recording;
  try {
    if (recording) {
      recordingIcon ??= drawRecordingIcon();
      await chrome.action.setIcon({ imageData: await recordingIcon });
    } else if (DEFAULT_ICON) {
      await chrome.action.setIcon({ path: DEFAULT_ICON });
    }
  } catch (error) {
    iconIsRecording = null; // try again next time
    recordingIcon = null;
    throw error;
  }
}

/** Our icon with a red dot (white ring) in the top-right corner, per size. */
async function drawRecordingIcon(): Promise<Record<number, ImageData>> {
  const out: Record<number, ImageData> = {};
  for (const size of ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context for the recording icon.");
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    const r = size * 0.24;
    const cx = size - r - size * 0.02;
    const cy = r + size * 0.02;
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(1, size * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e03131";
    ctx.fill();
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}
