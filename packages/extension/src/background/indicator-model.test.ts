import { describe, expect, it } from "vitest";
import type { ScreenRecordingState, VoiceRecordingState } from "../shared/state.js";
import { MIC_COLOR, REC_COLOR, indicatorFor } from "./indicator-model.js";

const page = { url: "http://localhost:5173/", title: "App" };
const T_1402 = Date.UTC(2026, 9, 13, 14, 2);
const T_1403 = Date.UTC(2026, 9, 13, 14, 3);
const formatClock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const shortcuts = { "toggle-recording": "Alt+D", "toggle-voice": "Alt+A" };

const tab: ScreenRecordingState = { id: "s1", source: "tab", startedAt: T_1402, page, tabId: 7 };
const display: ScreenRecordingState = { id: "s2", source: "display", startedAt: T_1402, page };
const voice: VoiceRecordingState = { id: "v1", startedAt: T_1403, page, microphoneLabel: "" };

describe("indicatorFor", () => {
  it("idle: no badge, the normal tooltip", () => {
    expect(indicatorFor({ recording: {}, shortcuts, formatClock })).toEqual({
      recording: false,
      text: "",
      color: REC_COLOR,
      title: "holt: open the QA side panel",
    });
  });

  it("idle with a known project names it", () => {
    expect(indicatorFor({ recording: {}, shortcuts, projectName: "acme-web", formatClock }).title).toBe("holt (acme-web): open the QA side panel");
  });

  it("tab recording: red REC with start time and the stop shortcut", () => {
    expect(indicatorFor({ recording: { screen: tab }, shortcuts, formatClock })).toEqual({
      recording: true,
      text: "REC",
      color: REC_COLOR,
      title: "holt: recording tab since 14:02 (Alt+D to stop)",
    });
  });

  it("voice note: orange MIC", () => {
    expect(indicatorFor({ recording: { voice }, shortcuts, formatClock })).toEqual({
      recording: true,
      text: "MIC",
      color: MIC_COLOR,
      title: "holt: voice note since 14:03 (Alt+A to stop)",
    });
  });

  it("both: REC wins the badge, the tooltip lists both", () => {
    const result = indicatorFor({ recording: { screen: tab, voice }, shortcuts, projectName: "acme", formatClock });
    expect(result.text).toBe("REC");
    expect(result.color).toBe(REC_COLOR);
    expect(result.title).toBe("holt (acme): recording tab since 14:02 (Alt+D to stop) · voice note since 14:03 (Alt+A to stop)");
  });

  it("window/screen recording from the panel says where to stop it", () => {
    const result = indicatorFor({ recording: { screen: display }, shortcuts, formatClock });
    expect(result.text).toBe("REC");
    expect(result.title).toMatch(/recording a window or screen since 14:02 \(stop it in the side panel/);
  });

  it("names the microphone, and says when the selected one was missing", () => {
    expect(indicatorFor({ recording: { voice: { ...voice, microphoneLabel: "USB Mic" } }, shortcuts, formatClock }).title).toBe(
      "holt: voice note since 14:03 on USB Mic (Alt+A to stop)",
    );
    expect(
      indicatorFor({ recording: { voice: { ...voice, microphoneLabel: "Built-in", microphoneFallback: true } }, shortcuts, formatClock }).title,
    ).toBe("holt: voice note since 14:03 on the default microphone (selected one not found) (Alt+A to stop)");
  });

  it("unbound or rebound shortcuts are reflected", () => {
    expect(indicatorFor({ recording: { screen: tab }, shortcuts: {}, formatClock }).title).toMatch(/\(stop it in the side panel\)$/);
    expect(indicatorFor({ recording: { voice }, shortcuts: { "toggle-voice": "⌥A" }, formatClock }).title).toMatch(/\(⌥A to stop\)$/);
  });

  it("formats the clock in local time by default", () => {
    const local = new Date(2026, 0, 1, 9, 5).getTime();
    expect(indicatorFor({ recording: { voice: { ...voice, startedAt: local } }, shortcuts }).title).toContain("since 09:05");
  });
});
