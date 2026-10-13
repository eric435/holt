/**
 * Panel-side uploads: post an entry (optionally after uploading media),
 * then update the session display and the recent-entries list.
 *
 * Used for what the panel itself creates: typed notes (also the "add a
 * note" field on screenshots) and window/screen recordings, which are
 * Blobs created here (see shared/api.ts). Tab recordings and voice notes
 * are uploaded by the offscreen document instead.
 */

import type { Entry, EntryInput, EntryKind } from "@holt/protocol";
import { getApi } from "../shared/api.js";
import { addRecentEntry } from "../shared/state.js";
import { update } from "./store.js";

export async function postEntry(input: EntryInput): Promise<Entry> {
  const api = await getApi();
  const { entry, session } = await api.postEntry(input);
  update({ session });
  await addRecentEntry({ sessionId: session.id, entry });
  return entry;
}

/** Upload `blob`, then post the entry built from the server-chosen file name. */
export async function uploadAndPost(blob: Blob, kind: EntryKind, build: (file: string) => EntryInput): Promise<Entry> {
  const api = await getApi();
  const media = await api.uploadMedia(blob, kind);
  update({ session: media.session });
  return postEntry(build(media.file));
}
