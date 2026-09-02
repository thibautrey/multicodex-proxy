#!/usr/bin/env node
import https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateRemoteTag(ref, tagObject, expectedTag, expectedCommit) {
  if (ref?.object?.type !== "tag" || !/^[0-9a-f]{40}$/.test(ref.object.sha ?? "")) throw new Error("remote ref must point to an annotated tag object");
  if (tagObject?.tag !== expectedTag) throw new Error("annotated tag name mismatch");
  if (tagObject?.object?.type !== "commit" || tagObject.object.sha !== expectedCommit) throw new Error("annotated tag peeled commit mismatch");
}

function getJson(path, token) {
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: "api.github.com", path, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "multivibe-source-release", "X-GitHub-Api-Version": "2022-11-28" } }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) request.destroy(new Error("GitHub tag response too large")); else chunks.push(chunk); });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`GitHub tag API returned ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("GitHub tag API timed out")));
  });
}

export async function main(environment = process.env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: repository, GITHUB_REF: refName, GITHUB_REF_NAME: tag, GITHUB_SHA: commit, GH_TOKEN: token } = environment;
  if (event !== "push" || repository !== "thibautrey/multivibe" || refName !== `refs/tags/${tag}`) throw new Error("untrusted release event identity");
  if (!/^source-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "") || !/^[0-9a-f]{40}$/.test(commit ?? "") || !token) throw new Error("invalid release tag environment");
  const encoded = encodeURIComponent(tag);
  const ref = await getJson(`/repos/thibautrey/multivibe/git/ref/tags/${encoded}`, token);
  if (ref?.object?.type !== "tag" || !/^[0-9a-f]{40}$/.test(ref.object.sha ?? "")) throw new Error("remote ref must point to an annotated tag object");
  const tagObject = await getJson(`/repos/thibautrey/multivibe/git/tags/${ref.object.sha}`, token);
  validateRemoteTag(ref, tagObject, tag, commit);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
