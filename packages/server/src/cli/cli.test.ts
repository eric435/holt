/**
 * The `holt` bin as a real process: exit codes, what it prints, and the
 * Ctrl+C path (SIGINT ends the active session, so notes.md gets its footer,
 * then the process exits 0). args.test.ts covers the parsing itself; this
 * file covers index.ts, the process glue that only exists in a child.
 *
 * Which binary: src/cli/index.ts bundled by esbuild into a temp dir before
 * the tests, with the same `__HOLT_VERSION__` define as tsup (which is
 * esbuild underneath). So the tests run the current source without needing
 * `pnpm build` first and can never pick up a stale dist/cli.js. The
 * published dist/ itself is checked by check-pack.
 *
 * Coverage note: v8 coverage is collected in the vitest process only, so
 * these tests do not move cli/index.ts's coverage number.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  CONFIG_FILE_NAME,
  type EntryResponse,
  type SessionResponse,
} from "@holt/protocol";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HELP_TEXT } from "./args.js";

const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const EXT_HEADERS = {
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
};

let binDir: string;
let cli: string;
const dirs: string[] = [];
const children = new Set<ChildProcess>();

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), "holt-cli-bin-"));
  cli = path.join(binDir, "cli.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: { __HOLT_VERSION__: JSON.stringify(PKG.version) },
    logLevel: "silent",
  });
});

afterEach(async () => {
  // A test that failed half-way must not leave a server running.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "holt-cli-"));
  dirs.push(dir);
  return dir;
}

interface Running {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(args: string[], cwd: string): Running {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    // An empty HOLT_TOKEN counts as unset (config/load.ts), so a token in
    // the developer's shell can't change what the server does here.
    env: { ...process.env, HOLT_TOKEN: "", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

/** Run to completion (these commands exit on their own). */
async function run(args: string[], cwd?: string) {
  const r = start(args, cwd ?? (await tempProject()));
  const { code } = await r.exited;
  return { code, stdout: r.stdout(), stderr: r.stderr() };
}

/** Resolve with `fn()`'s first truthy value; reject after `timeoutMs`. */
async function until<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("holt (the bin)", () => {
  it("--version prints the package version and exits 0", async () => {
    for (const flag of ["--version", "-v"]) {
      const { code, stdout, stderr } = await run([flag]);
      expect(code, flag).toBe(0);
      expect(stdout, flag).toBe(`${PKG.version}\n`);
      expect(stderr, flag).toBe("");
    }
  });

  it("--help prints the usage and exits 0", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${HELP_TEXT}\n`);
    expect(stdout).toMatch(/^Usage:\n {2}holt \[options\]/m);
  });

  it("`holt help` prints the same usage as --help", async () => {
    const { code, stdout } = await run(["help"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${HELP_TEXT}\n`);
  });

  it("an unknown flag exits 2 with one line naming it and pointing to --help, and starts nothing", async () => {
    const { code, stdout, stderr } = await run(["--prot", "4848"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    // Exactly one line: none of parseArgs's advice about "--" positionals.
    expect(stderr).toBe("[holt] error: Unknown option --prot. Run `holt --help` for usage.\n");
  });

  it("a bad config value exits 1 with the validator's message, not a stack trace", async () => {
    const { code, stderr } = await run(["--port", "70000"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/\[holt\] error: .*"port".*0 to 65535/s);
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("init writes holt.config.json in the working directory, then refuses to overwrite it", async () => {
    const dir = await tempProject();
    const first = await run(["init"], dir);
    expect(first.code).toBe(0);
    // Not compared as a whole path: the child reports its cwd, which can be
    // spelled differently from `dir` (macOS: /var is /private/var; Windows:
    // 8.3 short names like RUNNER~1 in the temp dir).
    expect(first.stdout).toMatch(/^\[holt\] Wrote .*[\\/]holt\.config\.json\n/);
    expect(JSON.parse(await readFile(path.join(dir, CONFIG_FILE_NAME), "utf8"))).toHaveProperty("outputDir", "qa");
    const again = await run(["init"], dir);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });

  // Windows has no POSIX signals: child.kill("SIGINT") there terminates the
  // process without running its handler, so there is nothing to test.
  it.skipIf(process.platform === "win32")(
    "SIGINT ends the active session (notes.md gets its footer) and exits 0",
    async () => {
      const dir = await tempProject();
      const server = start(["--port", "0"], dir);
      // The banner names the real port: "serving <project> at http://127.0.0.1:<port>/__holt".
      const api = await until(
        () => {
          if (server.child.exitCode !== null) throw new Error(`holt exited early:\n${server.stdout()}${server.stderr()}`);
          return server.stdout().match(new RegExp(` at (http://127\\.0\\.0\\.1:\\d+${BASE_PATH})\n`))?.[1];
        },
        "the server banner",
      );

      const post = (route: string, body: unknown) =>
        fetch(`${api}${route}`, {
          method: "POST",
          headers: { ...EXT_HEADERS, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const started = (await (await post("/session/start", {})).json()) as SessionResponse;
      const dirOfSession = started.session?.dir ?? "";
      // The server resolves qa/ against its cwd, the real path (macOS: /private/var).
      expect(path.relative(await realpath(dir), dirOfSession).split(path.sep)[0]).toBe("qa");
      const note = (await (
        await post("/entries", {
          kind: "note",
          capturedAt: new Date().toISOString(),
          page: { url: "http://localhost:5173/", title: "Home" },
          note: "Written before Ctrl+C.",
        })
      ).json()) as EntryResponse;
      expect(note.entry.seq).toBe(1);
      const notesPath = path.join(dirOfSession, "notes.md");
      expect(await readFile(notesPath, "utf8")).not.toContain("_Session ended at");

      server.child.kill("SIGINT");
      const exit = await server.exited;
      expect(exit, server.stderr()).toEqual({ code: 0, signal: null });
      const notes = await readFile(notesPath, "utf8");
      expect(notes).toContain("- Written before Ctrl+C.");
      expect(notes.trimEnd().split("\n").at(-1)).toMatch(/^_Session ended at \S+ \(1 entry\)\._$/);
      await expect(fetch(`${api}/status`, { headers: EXT_HEADERS })).rejects.toThrow();
    },
    20_000,
  );
});
