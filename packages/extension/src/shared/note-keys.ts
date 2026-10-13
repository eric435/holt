/**
 * Keyboard behaviour of the note fields (side panel and the Alt+T popup):
 *
 *   Enter              save
 *   Shift+Enter        newline (the textarea's default, so we do nothing)
 *   Ctrl/Cmd+Enter     save too (the old binding; muscle memory)
 *   Esc                cancel (the popup closes; the panel ignores it)
 *
 * While an input method editor is composing (Japanese, Chinese, ...), Enter
 * confirms the composition and must not save; `isComposing` says so. Chrome
 * also reports keyCode 229 for such keydowns, which we check as well.
 *
 * Pure so it is unit-tested.
 */

export type NoteKeyAction = "save" | "cancel" | null;

export interface NoteKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean | undefined;
  keyCode?: number | undefined;
}

export function noteKeyAction(e: NoteKeyEvent): NoteKeyAction {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key === "Enter" && !e.shiftKey) return "save";
  return null;
}
