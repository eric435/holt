/**
 * Project identity: the name the extension shows next to the server URL
 * ("acme-web at http://127.0.0.1:4848"), so someone with two dev servers
 * running can tell which repo their captures land in.
 *
 * Precedence, first match wins:
 *   1. `projectName` from config (file, CLI flag, or plugin option);
 *   2. the `name` field of `<root>/package.json`;
 *   3. the base name of the root directory.
 *
 * We deliberately do not walk up parent directories looking for a
 * package.json. In a monorepo, `examples/vite-app` should be "vite-app" (or
 * whatever its own package.json says), not the workspace root's name, and
 * the root is already the directory holt writes into.
 *
 * package.json is someone else's file that we only read for a label, so it
 * is treated defensively: missing, unreadable, too big, not JSON, or a name
 * that is not a usable string all fall through to the directory name. None
 * of that may stop the dev server from starting.
 *
 * Split into a pure resolver (`resolveProject`, takes the file contents) and
 * a thin reader (`readPackageJson`), so the rules are testable without a
 * file system.
 */
import { open } from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo } from "@holt/protocol";
import { MAX_PACKAGE_JSON_BYTES, MAX_PROJECT_NAME_LENGTH } from "./defaults.js";

/**
 * Characters removed from a name before it is displayed or logged: C0 and
 * C1 controls and DEL (a newline or ANSI escape in a package.json name must
 * not reach the terminal through our startup banner), plus the
 * zero-width and bidi-override characters that make text display as
 * something other than what it is (see session/escape.ts).
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** True if `value` contains a character `sanitizeProjectName` would remove. */
export function hasUnsafeChars(value: string): boolean {
  // A fresh regex: the shared one is global, so `.test` would keep state.
  return new RegExp(UNSAFE_CHARS.source).test(value);
}

/**
 * Strip unsafe characters, trim, and cap at MAX_PROJECT_NAME_LENGTH UTF-16
 * code units (the unit the protocol's "at most 100 characters" and a
 * client's `.length` check count in), without splitting a surrogate pair.
 * Returns "" if nothing is left.
 */
export function sanitizeProjectName(raw: string): string {
  let name = raw.replace(UNSAFE_CHARS, "").trim();
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    name = name.slice(0, MAX_PROJECT_NAME_LENGTH);
    // A lone high surrogate at the end is half of an emoji; drop it.
    if (/[\ud800-\udbff]$/.test(name)) name = name.slice(0, -1);
    name = name.trimEnd();
  }
  return name;
}

export interface ResolveProjectInput {
  /** Absolute project root. */
  root: string;
  /** The `projectName` config value, if set (already validated). */
  projectName?: string | undefined;
  /** Contents of <root>/package.json, or null if it is missing, unreadable, or too big. */
  packageJson: string | null;
}

export interface ResolvedProject {
  project: ProjectInfo;
  /** Set when package.json exists but is not JSON, for the caller to log. */
  warning?: string;
}

export function resolveProject({ root, projectName, packageJson }: ResolveProjectInput): ResolvedProject {
  if (projectName !== undefined) {
    const name = sanitizeProjectName(projectName);
    // Validation already rejected empty and unsafe values; this guard only
    // matters for callers that skip validation.
    if (name) return { project: { name, source: "config" } };
  }

  let warning: string | undefined;
  if (packageJson !== null) {
    let parsed: unknown;
    try {
      // Some Windows editors save a byte-order mark, which JSON.parse rejects
      // but npm accepts.
      parsed = JSON.parse(packageJson.replace(/^﻿/, ""));
    } catch (err) {
      warning =
        `${path.join(root, "package.json")} is not valid JSON (${(err as Error).message}); ` +
        `using the directory name as the project name. Set "projectName" to choose one.`;
    }
    const raw = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    // Scoped names ("@acme/web") are kept as they are: that is what people
    // call the package, and the extension only ever shows it as text.
    if (typeof raw === "string") {
      const name = sanitizeProjectName(raw);
      if (name) return { project: { name, source: "package.json" } };
    }
  }

  // path.basename("/") is "", and a directory name can in theory contain
  // anything; fall back to the root path itself, then to a fixed label, so
  // `name` is never empty.
  const name = sanitizeProjectName(path.basename(root)) || sanitizeProjectName(root) || "project";
  return { project: { name, source: "directory" }, ...(warning !== undefined && { warning }) };
}

/**
 * Read <root>/package.json for `resolveProject`. Returns null instead of
 * throwing on any error (missing, a directory, permissions), and also when
 * the file is larger than MAX_PACKAGE_JSON_BYTES: a real package.json is a
 * few KiB, and we will not buffer an arbitrarily large file to find a label.
 */
export async function readPackageJson(root: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path.join(root, "package.json"), "r");
  } catch {
    return null;
  }
  try {
    // Read one byte past the cap so "exactly at the cap" and "too big" are
    // told apart without trusting a stat() size that could change under us.
    const buffer = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_PACKAGE_JSON_BYTES) return null;
    return buffer.toString("utf8", 0, length);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Human description for startup banners: "acme-web (from package.json)". */
export function describeProject(project: ProjectInfo): string {
  switch (project.source) {
    case "config":
      return project.name;
    case "package.json":
      return `${project.name} (from package.json)`;
    case "directory":
      return `${project.name} (directory name)`;
  }
}
