#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [manifestPath, decisionPath, outputPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const decisionBytes = readFileSync(decisionPath);
const required = ["GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"];
for (const name of required) if (!process.env[name]) throw new Error(`missing ${name}`);
if (process.env.GITHUB_REPOSITORY !== manifest.repository || process.env.GITHUB_SHA !== manifest.commit || process.env.GITHUB_REF_NAME !== manifest.tag) throw new Error("workflow identity does not match release manifest");
const approval = {
  schemaVersion: 1,
  decision: "approve-public-source-distribution",
  repository: manifest.repository,
  commit: manifest.commit,
  tag: manifest.tag,
  archive: manifest.archive,
  archiveSha256: manifest.sha256,
  license: "Apache-2.0",
  scope: ["MultiVibe Core source", "provider-host worker source"],
  excluded: ["MultiVibe Cloud source and service", "trademarks", "model weights", "third-party license grants"],
  githubActor: process.env.GITHUB_ACTOR,
  githubRunId: process.env.GITHUB_RUN_ID,
  githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  recordedAtUtc: new Date().toISOString(),
  decisionRecordSha256: createHash("sha256").update(decisionBytes).digest("hex"),
  disclaimer: "Records the repository owner's explicit Apache-2.0 distribution decision only; no legal, tax, accounting, or fiscal review is asserted."
};
writeFileSync(outputPath, `${JSON.stringify(approval, null, 2)}\n`);
