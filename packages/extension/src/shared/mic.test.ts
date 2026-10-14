import { describe, expect, it } from "vitest";
import { isMissingDeviceError, microphoneConstraints } from "./mic.js";

describe("microphoneConstraints", () => {
  it("asks for exactly the chosen device", () => {
    expect(microphoneConstraints("abc")).toEqual({ audio: { deviceId: { exact: "abc" } } });
  });
  it("uses the default device when none is chosen", () => {
    expect(microphoneConstraints("")).toEqual({ audio: true });
  });
});

describe("isMissingDeviceError", () => {
  it.each(["OverconstrainedError", "NotFoundError"])("%s means the device is gone", (name) => {
    expect(isMissingDeviceError(name)).toBe(true);
  });
  it.each(["NotAllowedError", "NotReadableError", "AbortError", undefined])("%s is not retried with the default", (name) => {
    expect(isMissingDeviceError(name)).toBe(false);
  });
});
