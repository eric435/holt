/**
 * Panel-side uploads: post an entry (optionally after uploading media),
 * then update the session display and the recent-entries list.
 *
 * The panel talks to the server directly (not via the worker) because
 * recordings are Blobs created here, see shared/api.ts.
 */

import type { Entry, EntryInput, EntryKind } from "@nitpick/protocol";
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
