/**
 * What the welcome page (welcome.ts) says, decided without Chrome (pure,
 * unit-tested): the server line, and the shortcut rows.
 *
 * The server line answers "is the holt server running?" for the one place
 * the welcome page can check: the fixed/fallback URL from the settings
 * (http://127.0.0.1:4848 by default, where `npx @velvet-thunder/holt`
 * listens). With the Vite plugin the server lives on the dev server's own
 * origin, which the welcome page can't know (holt finds it from the page
 * being captured, shared/server-resolve.ts), so "not found" is worded as
 * "not yet", with that caveat, rather than as an error.
 */

import { COMMAND_LABELS, type CommandName, type ShortcutMap } from "../shared/shortcuts.js";
import { displayHost, projectName, type StatusLike } from "../shared/server-label.js";

export type ServerCheck =
  | { kind: "checking"; serverUrl: string }
  | { kind: "ok"; serverUrl: string; status: StatusLike }
  /** holt answered, but refuses requests without the token its config sets. */
  | { kind: "needs-token"; serverUrl: string }
  | { kind: "down"; serverUrl: string };

export interface ServerLine {
  tone: "grey" | "green" | "red";
  text: string;
  /** A second, muted line. */
  detail?: string;
}

export function serverLine(check: ServerCheck): ServerLine {
  const host = displayHost(check.serverUrl);
  switch (check.kind) {
    case "checking":
      return { tone: "grey", text: `Looking for a holt server at ${host}…` };
    case "ok": {
      const project = projectName(check.status);
      const version = typeof check.status.version === "string" && check.status.version ? ` ${check.status.version}` : "";
      return project
        ? { tone: "green", text: `Connected to ${project}`, detail: `holt${version} · ${host}` }
        : { tone: "green", text: `Connected to holt${version} at ${host}` };
    }
    case "needs-token":
      return { tone: "green", text: `Found holt at ${host}`, detail: "It requires a token (holt.config.json sets one): enter it in holt's menu → Settings." };
    case "down":
      return {
        tone: "red",
        text: `No server found at ${host} yet.`,
        detail:
          "Start it as shown above; this line turns green by itself. With the Vite plugin, holt finds the server on your app's own pages instead, so this line may stay red.",
      };
  }
}

export interface ShortcutRow {
  command: CommandName;
  label: string;
  /** The binding as Chrome shows it, or null when unbound. */
  key: string | null;
}

/** Every command, in the panel's order, with its current binding. */
export function shortcutRows(shortcuts: ShortcutMap): ShortcutRow[] {
  return COMMAND_LABELS.map(([command, label]) => ({ command, label, key: shortcuts[command] || null }));
}
