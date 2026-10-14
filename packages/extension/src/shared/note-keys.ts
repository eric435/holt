/**
 * Keyboard behaviour of the note fields (the note page: the Alt+T quick
 * note and the screenshot note prompt; and the transcript box on the page
 * while it is up for review):
 *
 *   Enter              save
 *   Shift+Enter        newline (the textarea's default, so we do nothing)
 *   Ctrl/Cmd+Enter     save too (the old binding; muscle memory)
 *   Esc                cancel: the quick note closes; the screenshot prompt
 *                      skips when nothing is typed and saves otherwise
 *                      (note/note.ts); the transcript box ignores it
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
