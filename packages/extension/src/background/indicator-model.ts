/**
 * What the toolbar icon should say, as a pure function of the recording
 * state (unit-tested). background/indicator.ts applies the result.
 *
 * Why the toolbar action is the "is something recording?" indicator:
 *  - it is always visible (top right of the window) even with the side
 *    panel closed, which is the point of headless mode;
 *  - it is browser chrome, so it never shows up in screenshots or tab
 *    recordings, unlike an overlay injected into the page;
 *  - it survives navigations and needs no host permissions or content
 *    script on every site.
 *
 * Badge: "REC" (red) for a tab or window/screen recording, "MIC" (orange)
 * for a voice note, "REC" if both (the tooltip lists both). The badge is
 * also used for short "✓"/"!" flashes (notify.ts), which is why the icon
 * itself gets a red dot too (indicator.ts): the dot stays visible while the
 * badge is busy flashing.
 */

import type { RecordingState } from "../shared/state.js";
import type { ShortcutMap } from "../shared/shortcuts.js";

export const REC_COLOR = "#e03131";
export const MIC_COLOR = "#f08c00";

export interface IndicatorInput {
  recording: RecordingState;
  shortcuts: ShortcutMap;
  /** From the server's /status, when the panel has seen it. */
  projectName?: string | undefined;
  /** Epoch ms -> "14:02". Injected so tests don't depend on the time zone. */
  formatClock?: (epochMs: number) => string;
}

export interface Indicator {
  /** Something is recording (show the red-dot icon). */
  recording: boolean;
  /** Badge text; "" = no badge. */
  text: string;
  /** Badge background colour (only meaningful when `text` is set). */
  color: string;
  /** Tooltip. */
  title: string;
}

export function indicatorFor({ recording, shortcuts, projectName, formatClock = clock }: IndicatorInput): Indicator {
  const name = projectName ? `nitpick (${projectName})` : "nitpick";
  const parts: string[] = [];

  const { screen, voice } = recording;
  if (screen) {
    if (screen.source === "tab") {
      parts.push(`recording tab since ${formatClock(screen.startedAt)} (${stopHint(shortcuts["toggle-recording"])})`);
    } else {
      parts.push(`recording a window or screen since ${formatClock(screen.startedAt)} (stop it in the side panel or Chrome's sharing bar)`);
    }
  }
  if (voice) {
    const mic = voice.microphoneFallback
      ? ` on the default microphone (selected one not found)`
      : voice.microphoneLabel
        ? ` on ${voice.microphoneLabel}`
        : "";
    parts.push(`voice note since ${formatClock(voice.startedAt)}${mic} (${stopHint(shortcuts["toggle-voice"])})`);
  }

  if (parts.length === 0) {
    return { recording: false, text: "", color: REC_COLOR, title: `${name}: open the QA side panel` };
  }
  return {
    recording: true,
    text: screen ? "REC" : "MIC",
    color: screen ? REC_COLOR : MIC_COLOR,
    title: `${name}: ${parts.join(" · ")}`,
  };
}

function stopHint(shortcut: string | undefined): string {
  return shortcut ? `${shortcut} to stop` : "stop it in the side panel";
}

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
