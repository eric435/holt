// Copies the repository's LICENSE into this package before each build, so
// the published tarball carries it (npm only packs files inside the
// package folder). Copied rather than committed so there is exactly one
// LICENSE to keep up to date; the copy is git-ignored.
import { copyFileSync } from "node:fs";

copyFileSync(new URL("../../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
