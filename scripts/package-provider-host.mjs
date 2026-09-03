#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractPreflightedTarArchive } from "./provider-host-tar-preflight.mjs";
import { pruneProductionNativeDependencies } from "./provider-host-native-dependencies.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const downloadHosts = new Set(["nodejs.org", "github.com", "release-assets.githubusercontent.com"]);
const maximumCommandOutputBytes = 64 * 1024 * 1024;
const maximumNodeFileBytes = 512 * 1024 * 1024;
const maximumNodeExtractedBytes = 1024 * 1024 * 1024;
const maximumOllamaFileBytes = 4 * 1024 * 1024 * 1024;
const maximumOllamaExtractedBytes = 12 * 1024 * 1024 * 1024;
const betterSQLiteSmokeTest = "const Database=require('better-sqlite3');const database=new Database(':memory:');try{const row=database.prepare('SELECT 1 AS value').get();if(row?.value!==1)throw new Error('better-sqlite3 smoke test failed')}finally{database.close()}";

function argumentsFrom(argv) {
  const options = { allowDirty: false, allowUnsigned: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--allow-unsigned") options.allowUnsigned = true;
    else if (["--version", "--output", "--sign-identity", "--notary-profile"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[{
        "--version": "version",
        "--output": "output",
        "--sign-identity": "signIdentity",
        "--notary-profile": "notaryProfile",
      }[argument]] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.version)) {
    throw new Error("--version must be a release version without a v prefix");
  }
  if (options.notaryProfile && !options.signIdentity) {
    throw new Error("--notary-profile requires --sign-identity");
  }
  options.output = path.resolve(options.output ?? path.join(repositoryRoot, "release"));
  return options;
}

function target() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { key: "darwin-arm64", goos: "darwin", goarch: "arm64", archive: "dmg" };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { key: "linux-amd64", goos: "linux", goarch: "amd64", archive: "tar.gz" };
  }
  throw new Error("provider-host packages can be built only on Apple Silicon or Linux amd64");
}

async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      shell: false,
    });
    let output = "";
    let outputExceeded = false;
    if (options.capture) child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > (options.captureLimit ?? maximumCommandOutputBytes)) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (outputExceeded) reject(new Error(`${program} produced excessive output`));
      else if (code === 0) resolve(output.trim());
      else reject(new Error(`${program} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function validateDependency(name, dependency, expectedArchive) {
  if (!dependency || typeof dependency !== "object" || dependency.archive !== expectedArchive ||
    Object.keys(dependency).sort().join("\0") !== ["archive", "sha256", "url"].join("\0") ||
    typeof dependency.url !== "string" || !/^[a-f0-9]{64}$/u.test(dependency.sha256)) {
    throw new Error(`${name} dependency entry is invalid`);
  }
  const parsed = new URL(dependency.url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !downloadHosts.has(parsed.hostname)) {
    throw new Error(`${name} dependency URL must be approved credential-free HTTPS`);
  }
  return dependency;
}

async function download(url, destination, expectedSHA256, maximumBytes) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !downloadHosts.has(parsed.hostname)) {
    throw new Error("dependency URL must be credential-free HTTPS");
  }
  const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`dependency download failed with HTTP ${response.status}`);
  const finalURL = new URL(response.url);
  if (finalURL.protocol !== "https:" || finalURL.username || finalURL.password || !downloadHosts.has(finalURL.hostname)) {
    throw new Error("dependency download redirected to an unapproved origin");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
    throw new Error("dependency size is invalid or exceeds the package ceiling");
  }
  const file = await open(destination, "wx", 0o600);
  const digest = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > maximumBytes) throw new Error("dependency exceeds the package ceiling");
      digest.update(chunk);
      await file.write(chunk);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (declared > 0 && received !== declared) throw new Error("dependency download is truncated");
  if (received < 1) throw new Error("dependency download is empty");
  if (digest.digest("hex") !== expectedSHA256) throw new Error("dependency digest mismatch");
}

async function extractTar(archive, destination, format, profile, maximumFileBytes, maximumExtractedBytes) {
  await extractPreflightedTarArchive(archive, destination, format, {
    profile,
    maximumFileBytes,
    maximumExtractedBytes,
  });
}

async function validateDereferenceableTree(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`dependency archive unexpectedly contains a symlink: ${child}`);
    } else if (entry.isDirectory()) {
      await validateDereferenceableTree(root, child);
    } else if (!entry.isFile()) {
      throw new Error(`dependency archive contains an unsupported entry: ${child}`);
    }
  }
}

async function copySource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (entry) => path.basename(entry) !== ".git",
  });
}

async function buildGo(moduleDirectory, output, versionVariable, version, selectedTarget, packagePath = ".") {
  await command("go", ["test", "./..."], { cwd: moduleDirectory });
  await command("go", [
    "build",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=-s -w -X main.${versionVariable}=${version}`,
    "-o",
    output,
    packagePath,
  ], {
    cwd: moduleDirectory,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: selectedTarget.goos,
      GOARCH: selectedTarget.goarch,
    },
  });
  await chmod(output, 0o555);
}

async function productionApplication(destination, selectedTarget) {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const file of ["package.json", "package-lock.json"]) {
    await cp(path.join(repositoryRoot, file), path.join(destination, file));
  }
  await command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: destination });
  await pruneProductionNativeDependencies(destination, selectedTarget.key);
  await rm(path.join(destination, "node_modules", ".bin"), { recursive: true, force: true });
  await copySource(path.join(repositoryRoot, "dist"), path.join(destination, "dist"));
  await copySource(path.join(repositoryRoot, "web-dist"), path.join(destination, "web-dist"));
  await mkdir(path.join(destination, "modules"), { recursive: true, mode: 0o755 });
  await copySource(path.join(repositoryRoot, "modules", "security"), path.join(destination, "modules", "security"));
}

async function nodeRuntime(work, destination, dependency) {
  const archive = path.join(work, "node.tar.gz");
  await download(dependency.url, archive, dependency.sha256, 512 * 1024 * 1024);
  const extraction = path.join(work, "node-extracted");
  await mkdir(extraction, { mode: 0o700 });
  await extractTar(
    archive,
    extraction,
    dependency.archive,
    "node-runtime",
    maximumNodeFileBytes,
    maximumNodeExtractedBytes,
  );
  const entries = await readdir(extraction, { withFileTypes: true });
  const root = entries.filter((entry) => entry.isDirectory());
  if (entries.length !== 1 || root.length !== 1) throw new Error("Node archive layout is invalid");
  const source = path.join(extraction, root[0].name, "bin", "node");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Node executable layout is invalid");
  await cp(source, destination);
  await chmod(destination, 0o555);
  return path.join(extraction, root[0].name, "LICENSE");
}

async function findOllamaRoot(extraction) {
  const direct = path.join(extraction, "bin", "ollama");
  try {
    if ((await lstat(direct)).isFile()) return extraction;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = await readdir(extraction, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (entries.length === 1 && directories.length === 1) {
    const nested = path.join(extraction, directories[0].name);
    try {
      if ((await lstat(path.join(nested, "bin", "ollama"))).isFile()) return nested;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function ollamaRuntime(work, destination, dependency, selectedTarget, version) {
  const archive = path.join(work, dependency.archive === "tar-zstd" ? "ollama.tar.zst" : "ollama.tar.gz");
  const maximumBytes = selectedTarget.goos === "darwin" ? 512 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
  await download(dependency.url, archive, dependency.sha256, maximumBytes);
  const extraction = path.join(work, "ollama-extracted");
  await mkdir(extraction, { mode: 0o700 });
  await extractTar(
    archive,
    extraction,
    dependency.archive,
    "ollama-runtime",
    maximumOllamaFileBytes,
    maximumOllamaExtractedBytes,
  );
  await validateDereferenceableTree(extraction);
  await mkdir(destination, { recursive: true, mode: 0o755 });

  if (selectedTarget.goos === "darwin") {
    let runtimeRoot = extraction;
    const entries = await readdir(extraction, { withFileTypes: true });
    let source = path.join(runtimeRoot, "ollama");
    try {
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) source = null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      source = null;
    }
    if (!source && entries.length === 1 && entries[0].isDirectory()) {
      runtimeRoot = path.join(extraction, entries[0].name);
      const candidate = path.join(runtimeRoot, "ollama");
      try {
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink()) source = candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!source) throw new Error("Ollama macOS archive layout is invalid");
    for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
      await cp(path.join(runtimeRoot, entry.name), path.join(destination, entry.name), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
    }
    await chmod(path.join(destination, "ollama"), 0o555);
  } else {
    const runtimeRoot = await findOllamaRoot(extraction);
    if (!runtimeRoot) throw new Error("Ollama Linux archive layout is invalid");
    const topLevel = await readdir(runtimeRoot, { withFileTypes: true });
    const allowed = new Set(["bin", "lib", "share"]);
    if (topLevel.some((entry) => !allowed.has(entry.name) || !entry.isDirectory())) {
      throw new Error("Ollama Linux archive contains an unexpected top-level entry");
    }
    const binEntries = await readdir(path.join(runtimeRoot, "bin"), { withFileTypes: true });
    if (binEntries.length !== 1 || binEntries[0].name !== "ollama" || !binEntries[0].isFile()) {
      throw new Error("Ollama Linux executable layout is invalid");
    }
    for (const entry of topLevel) {
      await cp(path.join(runtimeRoot, entry.name), path.join(destination, entry.name), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
    }
    await chmod(path.join(destination, "bin", "ollama"), 0o555);
  }
  await writeFile(path.join(destination, ".multivibe-bundle.json"), `${JSON.stringify({
    schema_version: "managed-ollama-bundle-v1",
    version,
    platform: selectedTarget.key,
    archive_sha256: dependency.sha256,
  })}\n`, { mode: 0o444 });
}

async function allFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release bundles may not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...await allFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`release bundle contains an unsupported entry: ${child}`);
  }
  return files;
}

async function signMacApplication(application, identity) {
  const contents = path.join(application, "Contents");
  const native = [];
  for (const file of await allFiles(contents)) {
    if (!file.startsWith(`Resources${path.sep}ollama-runtime${path.sep}`) &&
      !file.endsWith(".node") && !file.endsWith(".dylib") && !file.endsWith(".so")) continue;
    const handle = await open(path.join(contents, file), "r");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    await handle.close();
    if (bytesRead !== 4) continue;
    const magic = header.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      native.push(path.join(contents, file));
    }
  }
  for (const binary of new Set([
    ...native,
    path.join(contents, "Frameworks", "node"),
    path.join(contents, "Resources", "ollama-runtime", "ollama"),
    path.join(contents, "Helpers", "multivibe-provider-agent"),
    path.join(contents, "Helpers", "multivibe-runtime-benchmark"),
    path.join(contents, "MacOS", "multivibe-host"),
  ])) {
    await command("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", binary]);
  }
  await command("codesign", [
    "--force", "--sign", identity, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(repositoryRoot, "packaging", "macos", "MultiVibe.entitlements"),
    application,
  ]);
  await command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
}

async function notarizeMacApplication(application, profile, work) {
  const submission = path.join(work, "notary-submission.zip");
  await command("ditto", ["-c", "-k", "--keepParent", application, submission]);
  await command("xcrun", ["notarytool", "submit", submission, "--keychain-profile", profile, "--wait"]);
  await command("xcrun", ["stapler", "staple", application]);
  await command("xcrun", ["stapler", "validate", application]);
  await command("spctl", ["--assess", "--type", "execute", "--verbose=2", application]);
}

async function notarizeMacDiskImage(diskImage, profile) {
  await command("xcrun", ["notarytool", "submit", diskImage, "--keychain-profile", profile, "--wait"]);
  await command("xcrun", ["stapler", "staple", diskImage]);
  await command("xcrun", ["stapler", "validate", diskImage]);
  await command("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", diskImage]);
}

async function writeManifest(root, metadata) {
  const files = (await allFiles(root)).sort((left, right) => left.localeCompare(right));
  const entries = [];
  for (const relative of files) {
    if (relative === "manifest.json") continue;
    const file = path.join(root, relative);
    const info = await stat(file);
    entries.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await sha256(file) });
  }
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify({ ...metadata, files: entries }, null, 2)}\n`, { mode: 0o444 });
}

async function assemble(options, selectedTarget, work, dependencies, sourceCommit, buildNumber, sourceTreeDirty) {
  const baseName = `multivibe-host_${options.version}_${selectedTarget.key.replace("-", "_")}`;
  const root = path.join(work, baseName);
  await mkdir(root, { mode: 0o755 });
  await cp(path.join(repositoryRoot, "LICENSE"), path.join(root, "LICENSE"));
  await cp(path.join(repositoryRoot, "NOTICE"), path.join(root, "NOTICE"));
  await cp(path.join(repositoryRoot, "packaging", "PROVIDER-HOST-README.md"), path.join(root, "README.md"));
  const installerPlatform = selectedTarget.goos === "darwin" ? "macos" : "linux";
  for (const script of ["install.sh", "uninstall.sh"]) {
    const destination = path.join(root, script);
    await cp(path.join(repositoryRoot, "packaging", installerPlatform, script), destination);
    await chmod(destination, 0o555);
  }
  await mkdir(path.join(root, "THIRD_PARTY"), { mode: 0o755 });
  await cp(path.join(repositoryRoot, "packaging", "third-party", "ollama-LICENSE"), path.join(root, "THIRD_PARTY", "ollama-LICENSE"));
  await cp(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"), path.join(root, "THIRD_PARTY", "provider-host-dependencies.json"));
  const modelAssessments = path.join(root, "THIRD_PARTY", "provider-model-license-assessments");
  await mkdir(modelAssessments, { mode: 0o755 });
  await cp(
    path.join(repositoryRoot, "docs", "provider-model-license-assessments", "qwen2.5-0.5b.md"),
    path.join(modelAssessments, "qwen2.5-0.5b.md"),
  );

  let applicationDirectory;
  let nodeDestination;
  let ollamaDestination;
  let agentDestination;
  let benchmarkDestination;
  let hostDestination;
  let resourceDirectory;
  let verifierDestination;
  let macApplication;
  if (selectedTarget.goos === "darwin") {
    macApplication = path.join(root, "MultiVibe Host.app");
    const contents = path.join(macApplication, "Contents");
    applicationDirectory = path.join(contents, "Resources", "app");
    nodeDestination = path.join(contents, "Frameworks", "node");
    ollamaDestination = path.join(contents, "Resources", "ollama-runtime");
    agentDestination = path.join(contents, "Helpers", "multivibe-provider-agent");
    benchmarkDestination = path.join(contents, "Helpers", "multivibe-runtime-benchmark");
    hostDestination = path.join(contents, "MacOS", "multivibe-host");
    resourceDirectory = path.join(contents, "Resources", "provider");
    verifierDestination = path.join(contents, "Resources", "verify-provider-host.mjs");
    for (const directory of [applicationDirectory, path.dirname(nodeDestination), path.dirname(agentDestination), path.dirname(hostDestination)]) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    }
    const info = (await readFile(path.join(repositoryRoot, "packaging", "macos", "Info.plist"), "utf8"))
      .replaceAll("__MULTIVIBE_VERSION__", options.version)
      .replaceAll("__MULTIVIBE_BUILD__", buildNumber);
    await writeFile(path.join(contents, "Info.plist"), info);
  } else {
    applicationDirectory = path.join(root, "app");
    nodeDestination = path.join(root, "bin", "node");
    agentDestination = path.join(root, "bin", "multivibe-provider-agent");
    benchmarkDestination = path.join(root, "bin", "multivibe-runtime-benchmark");
    hostDestination = path.join(root, "bin", "multivibe-host");
    ollamaDestination = path.join(root, "runtime", "ollama");
    resourceDirectory = path.join(root, "resources", "provider");
    verifierDestination = path.join(root, "verify-provider-host.mjs");
    await mkdir(path.join(root, "bin"), { recursive: true, mode: 0o755 });
    await mkdir(resourceDirectory, { recursive: true, mode: 0o755 });
  }

  await productionApplication(applicationDirectory, selectedTarget);
  await mkdir(resourceDirectory, { recursive: true, mode: 0o755 });
  await cp(path.join(repositoryRoot, "packaging", "provider-model-catalog.json"), path.join(resourceDirectory, "provider-model-catalog.json"));
  await cp(path.join(repositoryRoot, "packaging", "provider-runtime-profiles.json"), path.join(resourceDirectory, "provider-runtime-profiles.json"));
  await cp(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"), path.join(resourceDirectory, "provider-host-dependencies.json"));
  await cp(path.join(repositoryRoot, "packaging", "schemas"), path.join(resourceDirectory, "schemas"), { recursive: true });
  await cp(path.join(repositoryRoot, "packaging", "examples"), path.join(resourceDirectory, "examples"), { recursive: true });
  await cp(path.join(repositoryRoot, "scripts", "verify-provider-host.mjs"), verifierDestination);
  await chmod(verifierDestination, 0o444);
  const nodeLicense = await nodeRuntime(work, nodeDestination, dependencies.node.artifacts[selectedTarget.key]);
  await cp(nodeLicense, path.join(root, "THIRD_PARTY", "node-LICENSE"));
  await command(nodeDestination, ["--eval", betterSQLiteSmokeTest], { cwd: applicationDirectory });
  await ollamaRuntime(work, ollamaDestination, dependencies.ollama.artifacts[selectedTarget.key], selectedTarget, dependencies.ollama.version);
  await buildGo(path.join(repositoryRoot, "provider-agent"), agentDestination, "providerAgentVersion", options.version, selectedTarget);
  await buildGo(
    path.join(repositoryRoot, "provider-agent"), benchmarkDestination, "runtimeBenchmarkVersion", options.version,
    selectedTarget, "./cmd/runtime-benchmark",
  );
  await buildGo(path.join(repositoryRoot, "host-application"), hostDestination, "hostApplicationVersion", options.version, selectedTarget);

  let macOSSignature = null;
  if (macApplication) {
    macOSSignature = options.notaryProfile ? "developer-id-notarized" : options.signIdentity ? "developer-id" : "unsigned-development";
    await writeFile(path.join(macApplication, "Contents", "Resources", "provider-host-release.json"), `${JSON.stringify({
      schemaVersion: 1,
      product: "multivibe-host",
      version: options.version,
      sourceCommit,
      platform: selectedTarget.goos,
      architecture: selectedTarget.goarch,
      sourceTreeDirty,
      releaseReady: !sourceTreeDirty && macOSSignature === "developer-id-notarized",
      macOSSignature,
    }, null, 2)}\n`, { mode: 0o444 });
    if (!options.signIdentity && !options.allowUnsigned) throw new Error("macOS packaging requires --sign-identity");
    if (options.signIdentity) {
      await signMacApplication(macApplication, options.signIdentity);
    }
    if (options.notaryProfile) {
      await notarizeMacApplication(macApplication, options.notaryProfile, work);
    }
    else if (!options.allowUnsigned) throw new Error("macOS packaging requires --notary-profile");
  }

  await writeManifest(root, {
    schemaVersion: 1,
    product: "multivibe-host",
    version: options.version,
    sourceCommit,
    platform: selectedTarget.goos,
    architecture: selectedTarget.goarch,
    sourceTreeDirty,
    releaseReady: !sourceTreeDirty && (selectedTarget.goos !== "darwin" || macOSSignature === "developer-id-notarized"),
    macOSSignature,
    node: dependencies.node,
    managedRuntime: dependencies.ollama,
  });
  await command(process.execPath, [path.join(repositoryRoot, "scripts", "verify-provider-host.mjs"), "--directory", root]);
  return { root, baseName };
}

export async function archiveBundle(bundle, options, selectedTarget) {
  await mkdir(options.output, { recursive: true, mode: 0o755 });
  const extension = selectedTarget.archive;
  const destination = path.join(options.output, `${bundle.baseName}.${extension}`);
  await rm(destination, { force: true });
  if (selectedTarget.archive === "dmg") {
    const diskImageRoot = path.join(path.dirname(bundle.root), "dmg-root");
    await mkdir(diskImageRoot, { mode: 0o755 });
    await command("ditto", [path.join(bundle.root, "MultiVibe Host.app"), path.join(diskImageRoot, "MultiVibe Host.app")]);
    await symlink("/Applications", path.join(diskImageRoot, "Applications"));
    await command("hdiutil", [
      "create", "-quiet", "-volname", "MultiVibe Host", "-srcfolder", diskImageRoot,
      "-format", "UDZO", "-imagekey", "zlib-level=9", destination,
    ]);
    if (options.signIdentity) {
      await command("codesign", ["--force", "--sign", options.signIdentity, "--timestamp", destination]);
    }
    if (options.notaryProfile) await notarizeMacDiskImage(destination, options.notaryProfile);
  } else {
    await command("tar", [
      "--format=ustar",
      "-czf",
      destination,
      "-C",
      path.dirname(bundle.root),
      path.basename(bundle.root),
    ]);
  }
  return destination;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const selectedTarget = target();
  const dependencies = JSON.parse(await readFile(path.join(repositoryRoot, "packaging", "provider-host-dependencies.json"), "utf8"));
  if (dependencies.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(dependencies.node?.version ?? "") ||
    !/^\d+\.\d+\.\d+$/u.test(dependencies.ollama?.version ?? "")) {
    throw new Error("provider-host dependency manifest is invalid");
  }
  for (const key of ["darwin-arm64", "linux-amd64"]) {
    validateDependency(`Node ${key}`, dependencies.node?.artifacts?.[key], "tar-gzip");
    validateDependency(
      `Ollama ${key}`,
      dependencies.ollama?.artifacts?.[key],
      key === "darwin-arm64" ? "tar-gzip" : "tar-zstd",
    );
  }
  const initialStatus = await command("git", ["status", "--porcelain"], { capture: true });
  if (initialStatus && !options.allowDirty) throw new Error("release packaging requires a clean worktree");
  const sourceCommit = await command("git", ["rev-parse", "HEAD"], { capture: true });
  const buildNumber = await command("git", ["rev-list", "--count", "HEAD"], { capture: true });
  await command("npm", ["run", "build"]);
  const finalStatus = await command("git", ["status", "--porcelain"], { capture: true });
  if (finalStatus && !options.allowDirty) throw new Error("the application build changed the release worktree");
  const work = await mkdtemp(path.join(tmpdir(), "multivibe-host-package-"));
  try {
    const bundle = await assemble(options, selectedTarget, work, dependencies, sourceCommit, buildNumber, Boolean(finalStatus));
    const archive = await archiveBundle(bundle, options, selectedTarget);
    await command(process.execPath, [path.join(repositoryRoot, "scripts", "verify-provider-host.mjs"), archive]);
    console.log(JSON.stringify({ archive, sha256: await sha256(archive), sourceCommit, target: selectedTarget.key }));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedDirectly()) {
  main().catch((error) => {
    console.error(`provider-host package failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
