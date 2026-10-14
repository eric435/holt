/**
 * Microphone selection, pure parts (unit-tested).
 *
 * The user picks a device in the side panel; we store its `deviceId`
 * (see shared/settings.ts). When recording we ask for exactly that device,
 * because a plain `{ deviceId: id }` is only a preference and Chrome would
 * silently pick another mic. If the device is gone (unplugged, or its id
 * changed because site data was cleared), `exact` makes getUserMedia fail
 * with OverconstrainedError (or NotFoundError), and we retry with the
 * default microphone and tell the user.
 *
 * Shared (not offscreen-only) because the screenshot note prompt
 * (note/note.ts) dictates with the same microphone as the recorders.
 */

export function microphoneConstraints(deviceId: string): MediaStreamConstraints {
  return deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
}

/** Errors that mean "that particular device isn't available", worth a retry with the default. */
export function isMissingDeviceError(name: string | undefined): boolean {
  return name === "OverconstrainedError" || name === "NotFoundError";
}
