import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";

const maximumEntries = 100_000;
const maximumMetadataBytes = 16 * 1024 * 1024;
const maximumStreamOverheadBytes = 256 * 1024 * 1024;

function safeArchiveEntry(value) {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return normalized.length > 0 && normalized.length <= 1024 && !normalized.startsWith("/") &&
    !normalized.startsWith("-") && !normalized.includes("\\") && /^[\x20-\x7e]+$/u.test(normalized) &&
    path.posix.normalize(normalized) === normalized &&
    normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function safeMetadataEntry(value, type) {
  if (type === "L" && value === "././@LongLink") return true;
  return safeArchiveEntry(value);
}

function parseTarNumber(value, label) {
  if (value.length < 1) throw new Error(`dependency tar ${label} is invalid`);
  if ((value[0] & 0x80) !== 0) {
    const bits = BigInt(value.length * 8 - 1);
    let parsed = BigInt(value[0] & 0x7f);
    for (const byte of value.subarray(1)) parsed = (parsed << 8n) | BigInt(byte);
    if ((value[0] & 0x40) !== 0) parsed -= 1n << bits;
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`dependency tar ${label} is out of range`);
    }
    return Number(parsed);
  }
  let start = 0;
  while (start < value.length && (value[start] === 0 || value[start] === 0x20)) start += 1;
  let end = start;
  while (end < value.length && value[end] >= 0x30 && value[end] <= 0x37) end += 1;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error(`dependency tar ${label} is invalid`);
  }
  if (start === end) return 0;
  const parsed = Number.parseInt(value.subarray(start, end).toString("ascii"), 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`dependency tar ${label} is out of range`);
  return parsed;
}

function parseTarString(value, label) {
  const terminator = value.indexOf(0);
  const end = terminator < 0 ? value.length : terminator;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error(`dependency tar ${label} is invalid`);
  }
  const content = value.subarray(0, end);
  if ([...content].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error(`dependency tar ${label} must be ASCII`);
  }
  return content.toString("ascii");
}

function validateTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("dependency tar checksum is invalid");
}

function parsePaxRecords(payload) {
  const records = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0 || space === offset) throw new Error("dependency tar PAX metadata is invalid");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]{0,7}$/u.test(lengthText)) throw new Error("dependency tar PAX metadata is invalid");
    const length = Number.parseInt(lengthText, 10);
    if (length < space - offset + 4 || offset + length > payload.length || payload[offset + length - 1] !== 0x0a) {
      throw new Error("dependency tar PAX metadata is invalid");
    }
    const record = payload.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("dependency tar PAX metadata is invalid");
    const key = record.subarray(0, equals).toString("ascii");
    const value = record.subarray(equals + 1).toString("utf8");
    const ignoredExtendedAttribute = key.startsWith("LIBARCHIVE.xattr.") || key.startsWith("SCHILY.xattr.");
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || records.has(key) ||
      (!ignoredExtendedAttribute && value.includes("\u0000"))) {
      throw new Error("dependency tar PAX metadata is invalid");
    }
    if (key.startsWith("GNU.sparse") || key === "SCHILY.realsize") {
      throw new Error("dependency tar PAX sparse metadata is unsupported");
    }
    if (key === "linkpath" || (!ignoredExtendedAttribute &&
      !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset", "comment"].includes(key))) {
      throw new Error(`dependency tar PAX metadata is unsupported: ${key}`);
    }
    records.set(key, value);
    offset += length;
  }
  return records;
}

class BoundedTarReader {
  constructor(stream, maximumBytes) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
    this.produced = 0;
    this.maximumBytes = maximumBytes;
  }

  async pull() {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buffer = Buffer.from(next.value);
    this.offset = 0;
    this.produced += this.buffer.length;
    if (this.produced > this.maximumBytes) throw new Error("dependency tar stream exceeds the decompression ceiling");
    return true;
  }

  async read(length, allowEnd = false) {
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffer.length && !await this.pull()) {
        if (allowEnd && written === 0) return null;
        throw new Error("dependency tar stream is truncated");
      }
      const available = Math.min(length - written, this.buffer.length - this.offset);
      this.buffer.copy(output, written, this.offset, this.offset + available);
      this.offset += available;
      written += available;
    }
    return output;
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.buffer.length && !await this.pull()) throw new Error("dependency tar stream is truncated");
      const available = Math.min(remaining, this.buffer.length - this.offset);
      this.offset += available;
      remaining -= available;
    }
  }
}

function zstdStream(archive) {
  const child = spawn("zstd", ["--quiet", "--decompress", "--stdout", "--", archive], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stderr = "";
  let stderrExceeded = false;
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 64 * 1024) {
      stderrExceeded = true;
      child.kill("SIGKILL");
    }
  });
  const completion = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
  return {
    stream: child.stdout,
    async finish() {
      const result = await completion;
      if (stderrExceeded || result.error || result.code !== 0) {
        throw new Error(`dependency zstd decompression failed${result.signal ? ` (${result.signal})` : ""}`);
      }
    },
    destroy() {
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function gzipStream(archive) {
  const source = createReadStream(archive);
  const gunzip = createGunzip();
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  return {
    stream: gunzip,
    async finish() {},
    destroy() {
      source.destroy();
      gunzip.destroy();
    },
  };
}

function resolveLinkTarget(entry) {
  if (!entry.link || entry.link.startsWith("/") || entry.link.includes("\\") || /[\0-\x1f\x7f]/u.test(entry.link)) {
    throw new Error("dependency tar link target is unsafe");
  }
  const candidate = entry.kind === "symlink"
    ? path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), entry.link))
    : path.posix.normalize(entry.link);
  if (!safeArchiveEntry(candidate)) {
    throw new Error("dependency tar link escapes its archive root");
  }
  return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
}

function validateEntryRelationships(entries, linkHandling) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const spellings = new Map();
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      const folded = prefix.toLowerCase();
      const previous = spellings.get(folded);
      if (previous && previous !== prefix) throw new Error("dependency tar contains a case-folded path collision");
      spellings.set(folded, prefix);
      if (index === parts.length) continue;
      const ancestor = byName.get(prefix);
      if (ancestor && ancestor.kind !== "directory") {
        throw new Error("dependency tar writes through a non-directory entry");
      }
    }
  }

  if (entries.some((entry) => entry.kind === "hardlink")) {
    throw new Error("dependency tar contains a hardlink");
  }
  const symlinks = entries.filter((entry) => entry.kind === "symlink");
  if (symlinks.length > 0 && linkHandling === "reject") {
    throw new Error("dependency tar contains a symlink");
  }

  const resolved = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (resolved.has(entry.name)) return resolved.get(entry.name);
    if (resolving.has(entry.name)) throw new Error("dependency tar contains a symlink cycle");
    resolving.add(entry.name);
    const target = resolveLinkTarget(entry);
    const targetEntry = byName.get(target);
    if (!targetEntry || !["file", "symlink"].includes(targetEntry.kind)) {
      throw new Error("dependency tar symlink target is not a declared regular file");
    }
    const finalTarget = targetEntry.kind === "file" ? targetEntry.name : resolve(targetEntry);
    resolving.delete(entry.name);
    resolved.set(entry.name, finalTarget);
    return finalTarget;
  };
  return symlinks.map((entry) => ({ name: entry.name, target: resolve(entry) }));
}

function preflightOptions(options) {
  const normalized = typeof options === "number"
    ? { maximumFileBytes: options, maximumExtractedBytes: options, linkHandling: "reject" }
    : options;
  const maximumFileBytes = normalized?.maximumFileBytes;
  const maximumExtractedBytes = normalized?.maximumExtractedBytes;
  const linkHandling = normalized?.linkHandling ?? "reject";
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1 ||
    !Number.isSafeInteger(maximumExtractedBytes) || maximumExtractedBytes < maximumFileBytes ||
    maximumExtractedBytes > 32 * 1024 * 1024 * 1024 || !["reject", "ignore", "materialize"].includes(linkHandling)) {
    throw new Error("dependency tar extraction ceiling is invalid");
  }
  return { maximumFileBytes, maximumExtractedBytes, linkHandling };
}

export async function preflightTarArchive(archive, format, options) {
  const { maximumFileBytes, maximumExtractedBytes, linkHandling } = preflightOptions(options);
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error("dependency tar archive is invalid");
  if (format !== "tar-gzip" && format !== "tar-zstd") throw new Error("dependency tar compression is unsupported");
  const decompressor = format === "tar-gzip" ? gzipStream(archive) : zstdStream(archive);
  const reader = new BoundedTarReader(decompressor.stream, maximumExtractedBytes + maximumStreamOverheadBytes);
  const names = new Set();
  const foldedNames = new Set();
  const entries = [];
  let metadataBytes = 0;
  let extractedBytes = 0;
  let entryCount = 0;
  let pendingPax = null;
  let pendingLongName = null;
  let sawEnd = false;
  try {
    while (true) {
      const header = await reader.read(512, true);
      if (header === null) break;
      if (header.every((byte) => byte === 0)) {
        const second = await reader.read(512);
        if (!second.every((byte) => byte === 0)) throw new Error("dependency tar end marker is invalid");
        sawEnd = true;
        while (true) {
          const padding = await reader.read(512, true);
          if (padding === null) break;
          if (!padding.every((byte) => byte === 0)) throw new Error("dependency tar has trailing data");
        }
        break;
      }
      validateTarChecksum(header);
      entryCount += 1;
      if (entryCount > maximumEntries) throw new Error("dependency tar contains too many entries");
      const headerName = parseTarString(header.subarray(0, 100), "path");
      const prefix = parseTarString(header.subarray(345, 500), "path prefix");
      const linkName = parseTarString(header.subarray(157, 257), "link target");
      const typeByte = header[156];
      const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const headerSize = parseTarNumber(header.subarray(124, 136), "size");
      const mode = parseTarNumber(header.subarray(100, 108), "mode");
      if (mode > 0o777) throw new Error("dependency tar entry mode is unsafe");
      metadataBytes += Buffer.byteLength(headerName) + Buffer.byteLength(prefix) + Buffer.byteLength(linkName);
      if (metadataBytes > maximumMetadataBytes) throw new Error("dependency tar metadata exceeds the ceiling");

      if (type === "x" || type === "L") {
        const metadataName = prefix ? `${prefix}/${headerName}` : headerName;
        if (!safeMetadataEntry(metadataName, type)) throw new Error("dependency tar metadata path is unsafe");
        if (headerSize > maximumMetadataBytes - metadataBytes) throw new Error("dependency tar metadata exceeds the ceiling");
        const payload = await reader.read(headerSize);
        await reader.skip((512 - (headerSize % 512)) % 512);
        metadataBytes += headerSize;
        if (type === "x") {
          if (pendingPax !== null) throw new Error("dependency tar has ambiguous PAX metadata");
          pendingPax = parsePaxRecords(payload);
        } else {
          if (pendingLongName !== null) throw new Error("dependency tar has ambiguous GNU metadata");
          let end = payload.length;
          while (end > 0 && payload[end - 1] === 0) end -= 1;
          pendingLongName = parseTarString(payload.subarray(0, end), "long path");
        }
        continue;
      }
      if (type === "g" || type === "K" || type === "S") throw new Error("dependency tar metadata type is unsupported");
      if (!["0", "1", "2", "5"].includes(type)) throw new Error("dependency tar contains a special or unsupported entry");
      if (pendingPax !== null && pendingLongName !== null) throw new Error("dependency tar path metadata is ambiguous");
      const paxPath = pendingPax?.get("path");
      const joinedHeaderName = prefix ? `${prefix}/${headerName}` : headerName;
      const rawName = paxPath ?? pendingLongName ?? joinedHeaderName;
      let size = headerSize;
      if (pendingPax?.has("size")) {
        const value = pendingPax.get("size");
        if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) throw new Error("dependency tar PAX size is invalid");
        const parsed = BigInt(value);
        if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("dependency tar PAX size is out of range");
        size = Number(parsed);
      }
      pendingPax = null;
      pendingLongName = null;
      if (!safeArchiveEntry(rawName)) throw new Error("dependency tar contains an unsafe path");
      const name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
      const foldedName = name.toLowerCase();
      if (names.has(name) || foldedNames.has(foldedName)) throw new Error("dependency tar contains duplicate paths");
      names.add(name);
      foldedNames.add(foldedName);
      const kind = type === "5" ? "directory" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "file";
      if ((kind !== "file" && size !== 0) || (kind === "file" && linkName !== "") ||
        ((kind === "symlink" || kind === "hardlink") && linkName === "") ||
        (kind !== "directory" && rawName.endsWith("/"))) {
        throw new Error("dependency tar entry type is inconsistent");
      }
      if (kind === "file") {
        if (size > maximumFileBytes) throw new Error("dependency tar entry exceeds the individual-size ceiling");
        if (size > maximumExtractedBytes - extractedBytes) throw new Error("dependency tar exceeds the extracted-size ceiling");
        extractedBytes += size;
      }
      entries.push({ name, kind, link: linkName, mode });
      await reader.skip(size);
      await reader.skip((512 - (size % 512)) % 512);
    }
    await decompressor.finish();
  } catch (error) {
    decompressor.destroy();
    throw error instanceof Error ? error : new Error("dependency tar stream is invalid");
  } finally {
    decompressor.destroy();
  }
  if (!sawEnd || pendingPax !== null || pendingLongName !== null || entries.length < 1) {
    throw new Error("dependency tar termination is invalid");
  }
  const symlinks = validateEntryRelationships(entries, linkHandling);
  const roots = [...new Set(entries.map((entry) => entry.name.split("/", 1)[0]))].sort();
  return {
    entries: entries.length,
    extractedBytes,
    roots,
    directories: entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name),
    regularFiles: entries.filter((entry) => entry.kind === "file").map((entry) => entry.name),
    symlinks,
    archiveIdentity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function intersectsPath(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isMacMetadataSidecar(name) {
  return name.split("/").some((part) => part === "__MACOSX" || part.startsWith("._"));
}

function extractionPlan(report, profile) {
  if (profile === "node-runtime") {
    if (report.roots.length !== 1) throw new Error("Node dependency archive must have one root");
    const root = report.roots[0];
    const members = [`${root}/bin/node`, `${root}/LICENSE`];
    if (members.some((member) => !report.regularFiles.includes(member))) {
      throw new Error("Node dependency archive is missing a required regular file");
    }
    for (const link of report.symlinks) {
      if (members.some((member) => intersectsPath(link.name, member) || intersectsPath(link.target, member))) {
        throw new Error("Node dependency archive links through a selected path");
      }
    }
    return { members, materializedLinks: [], declaredDirectories: [] };
  }
  if (profile === "ollama-runtime") {
    const members = report.regularFiles.filter((name) => !isMacMetadataSidecar(name));
    const materializedLinks = report.symlinks.filter((link) => !isMacMetadataSidecar(link.name));
    if (materializedLinks.some((link) => isMacMetadataSidecar(link.target))) {
      throw new Error("Ollama dependency archive links to ignored macOS metadata");
    }
    return {
      members,
      materializedLinks,
      declaredDirectories: report.directories,
    };
  }
  throw new Error("dependency tar extraction profile is unsupported");
}

function expectedDirectories(files, declaredDirectories) {
  const directories = new Set(declaredDirectories);
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

async function runTarSelection(archive, destination, format, membersFile) {
  const compression = format === "tar-gzip" ? ["-z"] : ["--zstd"];
  await new Promise((resolve, reject) => {
    const child = spawn("tar", [
      ...compression,
      "--no-xattrs",
      "-xf",
      archive,
      "-C",
      destination,
      "-T",
      membersFile,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let stderr = "";
    let exceeded = false;
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 64 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !exceeded) resolve();
      else reject(new Error(`dependency tar extraction failed${signal ? ` (${signal})` : ""}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function validateExtractedTree(root, expectedFiles, expectedDirectoriesSet, relative = "") {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`dependency tar unexpectedly materialized a symlink: ${child}`);
    if (entry.isDirectory()) {
      if (!expectedDirectoriesSet.has(child)) throw new Error(`dependency tar extracted an unexpected directory: ${child}`);
      await validateExtractedTree(root, expectedFiles, expectedDirectoriesSet, child);
    } else if (!entry.isFile() || !expectedFiles.has(child)) {
      throw new Error(`dependency tar extracted an unexpected entry: ${child}`);
    }
  }
  if (relative === "") {
    for (const file of expectedFiles) {
      const info = await lstat(path.join(root, file));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`dependency tar did not extract a regular file: ${file}`);
    }
  }
}

export async function extractPreflightedTarArchive(archive, destination, format, options) {
  const { profile, ...limits } = options ?? {};
  const linkHandling = profile === "node-runtime" ? "ignore" : profile === "ollama-runtime" ? "materialize" : "reject";
  const report = await preflightTarArchive(archive, format, { ...limits, linkHandling });
  const plan = extractionPlan(report, profile);
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || (await readdir(destination)).length !== 0) {
    throw new Error("dependency tar extraction destination must be an empty directory");
  }
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() ||
    ["dev", "ino", "size", "mtimeMs"].some((key) => archiveInfo[key] !== report.archiveIdentity[key])) {
    throw new Error("dependency tar archive changed after preflight");
  }

  const finalFiles = new Set([...plan.members, ...plan.materializedLinks.map((entry) => entry.name)]);
  const directories = expectedDirectories(finalFiles, plan.declaredDirectories);
  for (const directory of [...directories].sort((left, right) => left.split("/").length - right.split("/").length)) {
    await mkdir(path.join(destination, directory), { recursive: true, mode: 0o755 });
  }

  const selectionDirectory = await mkdtemp(path.join(path.dirname(destination), ".multivibe-tar-members-"));
  await chmod(selectionDirectory, 0o700);
  try {
    const membersFile = path.join(selectionDirectory, "members");
    await writeFile(membersFile, `${plan.members.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    await runTarSelection(archive, destination, format, membersFile);
  } finally {
    await rm(selectionDirectory, { recursive: true, force: true });
  }

  for (const link of plan.materializedLinks) {
    const source = path.join(destination, link.target);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`dependency tar symlink target was not extracted as a regular file: ${link.target}`);
    }
    await cp(source, path.join(destination, link.name), {
      dereference: true,
      errorOnExist: true,
      force: false,
    });
  }
  await validateExtractedTree(destination, finalFiles, directories);
  return { ...report, extractedFiles: [...finalFiles].sort() };
}
