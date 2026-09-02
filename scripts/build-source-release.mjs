#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const [tag, commit, output = "release-out"] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
if (!/^source-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) fail("invalid source-release tag");
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) fail("commit must be lowercase 40-hex");
const head = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
if (head !== commit) fail("tag and requested commit differ");
for (const required of ["LICENSE", "NOTICE", "release/source-distribution-decision.json"]) {
  execFileSync("git", ["cat-file", "-e", `${commit}:${required}`]);
}
const license = execFileSync("git", ["show", `${commit}:LICENSE`], { encoding: "utf8" });
if (!license.includes("Apache License") || !license.includes("Version 2.0")) fail("archive commit lacks Apache-2.0 LICENSE");
JSON.parse(execFileSync("git", ["show", `${commit}:release/source-distribution-decision.json`], { encoding: "utf8" }));
mkdirSync(output, { recursive: true });
const archive = resolve(output, `multivibe-${tag}-source.tar.gz`);
const shell = `set -euo pipefail; git archive --format=tar --prefix='multivibe-${tag}/' '${commit}' | gzip -n -9 > '${archive.replaceAll("'", "'\\''")}'`;
execFileSync("bash", ["-c", shell], { stdio: "inherit" });
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(resolve(output, "SHA256SUMS"), `${digest}  ${basename(archive)}\n`, { mode: 0o644 });
const manifest = { schemaVersion: 1, repository: "thibautrey/multivibe", commit, tag, archive: basename(archive), sha256: digest, license: "Apache-2.0", requiredNotices: ["LICENSE", "NOTICE"] };
writeFileSync(resolve(output, "source-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
