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
 * Badge: "REC" (red) for a tab recording, "MIC" (orange)
 * for a voice note, "REC" if both (the tooltip lists both). The badge is
 * also used for short "✓"/"!" flashes (notify.ts), which is why the icon
 * itself gets a red dot too (indicator.ts): the dot stays visible while the
 * badge is busy flashing.
 *
 * Not recording: no badge while holt is reachable (the tooltip names the
 * project), and a red "!" while no holt server answers for the page in
 * front (`serverInfo`, background/server-info.ts), so you see it before
 * your first capture fails rather than after. Only on pages on this machine
 * (loopback), though: on any other website there is nothing to auto-detect,
 * and a permanently red icon while you browse the web would be noise. The
 * toolbar menu explains the problem on every page.
 */

import type { RecordingState, ServerInfo } from "../shared/state.js";
import type { ShortcutMap } from "../shared/shortcuts.js";

export const REC_COLOR = "#e03131";
export const MIC_COLOR = "#f08c00";

export interface IndicatorInput {
  recording: RecordingState;
  shortcuts: ShortcutMap;
  /** The server for the page in front, as the worker last checked it. */
  server?: ServerInfo | undefined;
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

export function indicatorFor({ recording, shortcuts, server, formatClock = clock }: IndicatorInput): Indicator {
  const projectName = server?.ok ? server.project : null;
  const name = projectName ? `holt (${projectName})` : "holt";
  const parts: string[] = [];

  const { screen, voice } = recording;
  if (screen) parts.push(`recording tab since ${formatClock(screen.startedAt)} (${stopHint(shortcuts["toggle-recording"])})`);
  if (voice) {
    const mic = voice.microphoneFallback
      ? ` on the default microphone (selected one not found)`
      : voice.microphoneLabel
        ? ` on ${voice.microphoneLabel}`
        : "";
    parts.push(`voice note since ${formatClock(voice.startedAt)}${mic} (${stopHint(shortcuts["toggle-voice"])})`);
  }

  if (parts.length === 0) {
    if (server && !server.ok && server.localPage) {
      return { recording: false, text: "!", color: REC_COLOR, title: `holt: no server for this page — ${server.message}` };
    }
    return { recording: false, text: "", color: REC_COLOR, title: name };
  }
  return {
    recording: true,
    text: screen ? "REC" : "MIC",
    color: screen ? REC_COLOR : MIC_COLOR,
    title: `${name}: ${parts.join(" · ")}`,
  };
}

function stopHint(shortcut: string | undefined): string {
  return shortcut ? `${shortcut} to stop` : "click to stop";
}

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
