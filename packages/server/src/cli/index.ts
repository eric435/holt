#!/usr/bin/env node
/**
 * The `holt` bin. Kept thin: parse flags, then hand off to the same
 * createHolt() + startStandalone() that the programmatic API exposes.
 *
 * Exit codes: 0 ok, 1 runtime/config error, 2 usage error.
 */
import { createHolt } from "../core.js";
import { startStandalone } from "../adapters/standalone.js";
import { createConsoleLogger } from "../log.js";
import { VERSION } from "../version.js";
import { CliUsageError, HELP_TEXT, parseCliArgs, type CliCommand } from "./args.js";
import { writeStarterConfig } from "./init.js";

const logger = createConsoleLogger();

async function main(argv: string[]): Promise<void> {
  let cmd: CliCommand;
  try {
    cmd = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      logger.error(`${err.message}\nRun \`holt --help\` for usage.`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  switch (cmd.command) {
    case "help":
      console.log(HELP_TEXT);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "init": {
      const file = await writeStarterConfig(process.cwd(), cmd.force);
      logger.info(`Wrote ${file}`);
      logger.info("Next: run `npx holt-qa` (or add the Vite plugin) and connect the extension.");
      return;
    }
    case "serve": {
      const holt = await createHolt({
        cwd: process.cwd(),
        overrides: cmd.overrides,
        overridesSource: "command line flags",
        ...(cmd.configFile !== undefined && { configFile: cmd.configFile }),
        logger,
      });
      await startStandalone(holt, { logger, handleSignals: true });
      return;
    }
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  // Print the message, not the stack: everything that can go wrong here
  // (bad config, port in use, file exists, EACCES) is something the user
  // fixes, and Node's messages already name the file or port involved.
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
