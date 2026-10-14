#!/usr/bin/env node
/**
 * Run the standalone holt server from this repo against some other project.
 *
 *   pnpm start:server <project-dir> [holt flags…]
 *
 * Why this exists: `pnpm dev:server` is only `tsup --watch` (it rebuilds
 * packages/server/dist on change, it never listens on a port), and the CLI
 * writes sessions into whatever directory it is started from. Running
 * `node packages/server/dist/cli.js` from the repo root would therefore put
 * QA notes into holt's own qa/ folder. This script runs the built CLI with
 * the given project as its working directory, which is what `npx holt`
 * does for people who installed the package.
 *
 * The `start:server` script builds the server package first, so dist/ is
 * never stale. Flags after the directory go straight to the CLI
 * (`--port`, `--token`, …; see `holt --help`).
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repoRoot, "packages/server/dist/cli.js");

const args = process.argv.slice(2);
const dirArg = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;

// pnpm sets INIT_CWD to where `pnpm` was invoked, so `cd my-app && pnpm --dir
// ~/holt start:server` also works without repeating the directory.
const initCwd = process.env.INIT_CWD && resolve(process.env.INIT_CWD);
const projectDir = dirArg ? resolve(dirArg) : initCwd && initCwd !== repoRoot ? initCwd : undefined;

if (!projectDir) {
  console.error(
    "usage: pnpm start:server <project-dir> [holt flags…]\n\n" +
      "The server writes sessions into the directory it runs from, so name the\n" +
      "project you want the notes in (not this repo).",
  );
  process.exit(2);
}
if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
  console.error(`start-server: ${projectDir} is not a directory`);
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error(`start-server: ${cli} is missing; run \`pnpm --filter @velvet-thunder/holt build\` first`);
  process.exit(2);
}

// stdio: "inherit" puts the child in our terminal, so Ctrl+C reaches it
// directly and the CLI's own SIGINT handling ends the session cleanly.
const child = spawn(process.execPath, [cli, ...args], { cwd: projectDir, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
