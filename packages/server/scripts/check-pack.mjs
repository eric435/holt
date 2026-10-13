// Fails if the npm tarball would contain anything unexpected, or lack
// something it needs. CI previews the file list with `npm pack --dry-run`;
// this turns that preview into a check. Run after `build`.
//
//   pnpm --filter nitpick-notes check-pack
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageDir = new URL("..", import.meta.url);

/** Every published file must match one of these. */
const ALLOWED = [/^dist\/.+/, /^schema\.json$/, /^README\.md$/, /^LICENSE$/, /^package\.json$/];

/** And these must be present. */
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "schema.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/vite.js",
  "dist/vite.d.ts",
  "dist/cli.js",
];

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--loglevel=error"], {
  cwd: packageDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = pack.files.map((f) => f.path).sort();

const problems = [];
for (const file of files) {
  if (!ALLOWED.some((pattern) => pattern.test(file))) problems.push(`unexpected file in package: ${file}`);
}
for (const file of REQUIRED) {
  if (!files.includes(file)) problems.push(`missing from package: ${file}${file.startsWith("dist/") || file === "LICENSE" ? " (run the build first)" : ""}`);
}

// The package promises zero runtime dependencies (docs/SECURITY.md).
const pkg = JSON.parse(readFileSync(new URL("package.json", packageDir), "utf8"));
for (const field of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
  const deps = pkg[field];
  if (deps && (Array.isArray(deps) ? deps.length : Object.keys(deps).length) > 0) {
    problems.push(`package.json "${field}" must be empty (zero runtime dependencies)`);
  }
}

if (problems.length > 0) {
  console.error(`check-pack: ${pack.name}@${pack.version} failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-pack: ${pack.name}@${pack.version} OK, ${files.length} files:\n${files.map((f) => `  ${f}`).join("\n")}`);
