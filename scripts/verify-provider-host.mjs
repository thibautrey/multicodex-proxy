#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createGunzip, createInflateRaw } from "node:zlib";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const maximumArchiveBytes = 6 * 1024 * 1024 * 1024;
const maximumExtractedBytes = 6 * 1024 * 1024 * 1024;
const maximumArchiveEntries = 100_000;
const maximumArchiveMetadataBytes = 1024 * 1024;
const maximumZipCentralDirectoryBytes = 128 * 1024 * 1024;
const maximumTarStreamBytes = maximumExtractedBytes + maximumArchiveEntries * 1024 + maximumArchiveMetadataBytes + 1024;
const maximumCommandOutputBytes = 64 * 1024 * 1024;
const expectedAppleTeamIdentifier = "5E2CNR9H47";
const approvedDownloadHosts = new Set(["nodejs.org", "github.com", "release-assets.githubusercontent.com"]);

function argumentsFrom(argv) {
  const options = { requireRuntime: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-runtime") options.requireRuntime = true;
    else if (argument === "--directory") {
      if (options.directory || options.archive || !argv[index + 1]) throw new Error("--directory requires one path");
      options.directory = path.resolve(argv[index + 1]);
      index += 1;
    } else if (!argument.startsWith("-") && !options.archive && !options.directory) {
      options.archive = path.resolve(argument);
    } else {
      throw new Error("usage: verify-provider-host.mjs [--require-runtime] <archive> | --directory <path>");
    }
  }
  if (Boolean(options.archive) === Boolean(options.directory)) {
    throw new Error("exactly one provider-host archive or directory is required");
  }
  return options;
}

async function command(program, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const captureStderr = options.capture && options.captureStderr === true;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", captureStderr ? "pipe" : "inherit"] : "inherit",
      shell: false,
    });
    let output = "";
    let outputExceeded = false;
    const capture = (stream) => stream?.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > (options.captureLimit ?? maximumCommandOutputBytes)) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      });
    if (options.capture) capture(child.stdout);
    if (captureStderr) capture(child.stderr);
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

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && !value.includes("\\") && !/[\0-\x1f\x7f]/u.test(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function safeArchiveEntry(value) {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return safeRelative(normalized) && normalized.length <= 1024;
}

async function allFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`provider-host archive contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await allFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`provider-host archive contains an unsupported entry: ${child}`);
  }
  return files;
}

async function readExactly(handle, position, length, fileSize) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 ||
    position + length > fileSize) {
    throw new Error("provider-host archive structure is invalid");
  }
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(value, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("provider-host archive is truncated");
    offset += bytesRead;
  }
  return value;
}

function asciiArchiveName(value) {
  if (value.length < 1 || [...value].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error("provider-host archive contains a non-ASCII path");
  }
  return value.toString("ascii");
}

function validateZipExtra(value) {
  let offset = 0;
  while (offset < value.length) {
    if (offset + 4 > value.length) throw new Error("provider-host zip metadata is invalid");
    const identifier = value.readUInt16LE(offset);
    const length = value.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > value.length) throw new Error("provider-host zip metadata is invalid");
    // Timestamp and numeric uid/gid fields are the only extractor-visible extras
    // emitted by the release tools. Zip64, Unicode path overrides and encryption
    // extras are deliberately unsupported so the inspected name is the extracted name.
    if (![0x5455, 0x5855, 0x7875].includes(identifier)) {
      throw new Error("provider-host zip contains unsupported metadata");
    }
    offset += length;
  }
}

function zipEntryKind(versionMadeBy, externalAttributes, name) {
  const trailingSlash = name.endsWith("/");
  const creator = versionMadeBy >>> 8;
  if (creator === 3 || creator === 19) {
    const type = (externalAttributes >>> 16) & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
      throw new Error("provider-host archive contains a link or special entry");
    }
    if ((type === 0o040000) !== trailingSlash || (type === 0o100000 && trailingSlash)) {
      throw new Error("provider-host zip entry type is inconsistent");
    }
  } else {
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (dosDirectory !== trailingSlash) throw new Error("provider-host zip entry type is inconsistent");
  }
  return trailingSlash ? "directory" : "file";
}

async function validateZipDeflatePayload(archive, entry) {
  if (entry.compressedSize < 1) throw new Error("provider-host zip deflate payload is invalid");
  const source = createReadStream(archive, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.compressedSize - 1,
  });
  const inflater = createInflateRaw();
  source.once("error", (error) => inflater.destroy(error));
  source.pipe(inflater);
  let actual = 0;
  try {
    for await (const chunk of inflater) {
      actual += chunk.length;
      if (actual > entry.uncompressedSize || actual > maximumExtractedBytes) {
        throw new Error("provider-host archive exceeds the extracted-size ceiling");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("extracted-size ceiling")) throw error;
    throw new Error("provider-host zip payload is invalid");
  } finally {
    source.destroy();
    inflater.destroy();
  }
  if (actual !== entry.uncompressedSize) throw new Error("provider-host zip declared size is inconsistent");
}

async function inspectZipArchive(archive, archiveInfo) {
  const handle = await open(archive, "r");
  try {
    if (archiveInfo.size < 22) throw new Error("provider-host zip is truncated");
    const tailLength = Math.min(archiveInfo.size, 22 + 0xffff);
    const tailPosition = archiveInfo.size - tailLength;
    const tail = await readExactly(handle, tailPosition, tailLength, archiveInfo.size);
    let endOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        endOffset = tailPosition + offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error("provider-host zip end record is invalid");
    const end = tail.subarray(endOffset - tailPosition);
    const disk = end.readUInt16LE(4);
    const centralDisk = end.readUInt16LE(6);
    const diskEntries = end.readUInt16LE(8);
    const entryCount = end.readUInt16LE(10);
    const centralSize = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    const commentLength = end.readUInt16LE(20);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 ||
      entryCount === 0xffff || entryCount > maximumArchiveEntries || centralSize === 0xffffffff ||
      centralOffset === 0xffffffff || centralSize > maximumZipCentralDirectoryBytes || commentLength !== 0 ||
      centralOffset + centralSize !== endOffset) {
      throw new Error("provider-host zip layout is unsupported or exceeds a ceiling");
    }
    const central = await readExactly(handle, centralOffset, centralSize, archiveInfo.size);
    const entries = [];
    const names = new Set();
    const foldedNames = new Set();
    let centralCursor = 0;
    let metadataBytes = 0;
    let extractedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (centralCursor + 46 > central.length || central.readUInt32LE(centralCursor) !== 0x02014b50) {
        throw new Error("provider-host zip central directory is invalid");
      }
      const versionMadeBy = central.readUInt16LE(centralCursor + 4);
      const versionNeeded = central.readUInt16LE(centralCursor + 6);
      const flags = central.readUInt16LE(centralCursor + 8);
      const method = central.readUInt16LE(centralCursor + 10);
      const crc32 = central.readUInt32LE(centralCursor + 16);
      const compressedSize = central.readUInt32LE(centralCursor + 20);
      const uncompressedSize = central.readUInt32LE(centralCursor + 24);
      const nameLength = central.readUInt16LE(centralCursor + 28);
      const extraLength = central.readUInt16LE(centralCursor + 30);
      const entryCommentLength = central.readUInt16LE(centralCursor + 32);
      const diskStart = central.readUInt16LE(centralCursor + 34);
      const externalAttributes = central.readUInt32LE(centralCursor + 38);
      const localOffset = central.readUInt32LE(centralCursor + 42);
      const recordLength = 46 + nameLength + extraLength + entryCommentLength;
      if (centralCursor + recordLength > central.length || versionNeeded > 20 || diskStart !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        ![0, 8].includes(method) || (flags & ~0x080e) !== 0 || (method === 0 && (flags & 0x0006) !== 0)) {
        throw new Error("provider-host zip entry uses unsupported features");
      }
      const nameBytes = central.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
      const extra = central.subarray(centralCursor + 46 + nameLength, centralCursor + 46 + nameLength + extraLength);
      const name = asciiArchiveName(nameBytes);
      const canonicalName = name.endsWith("/") ? name.slice(0, -1) : name;
      const foldedName = canonicalName.toLowerCase();
      metadataBytes += nameLength + extraLength + entryCommentLength;
      if (metadataBytes > maximumArchiveMetadataBytes) throw new Error("provider-host archive metadata exceeds the ceiling");
      validateZipExtra(extra);
      if (!safeArchiveEntry(name)) throw new Error("provider-host archive contains an unsafe path");
      if (names.has(canonicalName) || foldedNames.has(foldedName)) {
        throw new Error("provider-host archive contains duplicate paths");
      }
      names.add(canonicalName);
      foldedNames.add(foldedName);
      const kind = zipEntryKind(versionMadeBy, externalAttributes, name);
      if (kind === "directory" && (compressedSize !== 0 || uncompressedSize !== 0)) {
        throw new Error("provider-host zip directory has data");
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new Error("provider-host zip stored size is inconsistent");
      }
      extractedBytes += uncompressedSize;
      if (extractedBytes > maximumExtractedBytes) throw new Error("provider-host archive exceeds the extracted-size ceiling");
      entries.push({
        name, canonicalName, kind, flags, method, crc32, compressedSize, uncompressedSize, localOffset,
        dataOffset: 0, rangeEnd: 0,
      });
      centralCursor += recordLength;
    }
    if (centralCursor !== central.length) throw new Error("provider-host zip central directory has trailing data");

    for (const entry of entries) {
      const local = await readExactly(handle, entry.localOffset, 30, archiveInfo.size);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method) {
        throw new Error("provider-host zip local header is inconsistent");
      }
      const localCrc = local.readUInt32LE(14);
      const localCompressedSize = local.readUInt32LE(18);
      const localUncompressedSize = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const localMetadata = await readExactly(handle, entry.localOffset + 30,
        localNameLength + localExtraLength, archiveInfo.size);
      const localName = localMetadata.subarray(0, localNameLength);
      const localExtra = localMetadata.subarray(localNameLength);
      metadataBytes += localNameLength + localExtraLength;
      if (metadataBytes > maximumArchiveMetadataBytes) throw new Error("provider-host archive metadata exceeds the ceiling");
      validateZipExtra(localExtra);
      if (!localName.equals(Buffer.from(entry.name, "ascii"))) {
        throw new Error("provider-host zip local path differs from its central path");
      }
      const usesDescriptor = (entry.flags & 0x0008) !== 0;
      if ((!usesDescriptor && (localCrc !== entry.crc32 || localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)) || (usesDescriptor &&
        ![0, entry.crc32].includes(localCrc)) || (usesDescriptor &&
        ![0, entry.compressedSize].includes(localCompressedSize)) || (usesDescriptor &&
        ![0, entry.uncompressedSize].includes(localUncompressedSize))) {
        throw new Error("provider-host zip local sizes are inconsistent");
      }
      entry.dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
      let rangeEnd = entry.dataOffset + entry.compressedSize;
      if (rangeEnd > centralOffset) throw new Error("provider-host zip payload range is invalid");
      if (usesDescriptor) {
        const available = centralOffset - rangeEnd;
        if (available < 12) throw new Error("provider-host zip data descriptor is truncated");
        const descriptor = await readExactly(handle, rangeEnd, Math.min(16, available), archiveInfo.size);
        const signed = descriptor.readUInt32LE(0) === 0x08074b50;
        const cursor = signed ? 4 : 0;
        if (descriptor.length < cursor + 12 || descriptor.readUInt32LE(cursor) !== entry.crc32 ||
          descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize ||
          descriptor.readUInt32LE(cursor + 8) !== entry.uncompressedSize) {
          throw new Error("provider-host zip data descriptor is inconsistent");
        }
        rangeEnd += cursor + 12;
      }
      entry.rangeEnd = rangeEnd;
    }
    const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
    let previousEnd = 0;
    for (const entry of localOrder) {
      if (entry.localOffset < previousEnd || entry.rangeEnd > centralOffset) {
        throw new Error("provider-host zip entries overlap");
      }
      previousEnd = entry.rangeEnd;
    }
    for (const entry of entries) {
      if (entry.kind === "file" && entry.method === 8) await validateZipDeflatePayload(archive, entry);
    }
    const roots = new Set(entries.map((entry) => entry.canonicalName.split("/", 1)[0]));
    if (roots.size !== 1) throw new Error("provider-host archive root is invalid");
    return [...roots][0];
  } finally {
    await handle.close();
  }
}

function parseTarNumber(value, label) {
  if (value.length < 1) throw new Error(`provider-host tar ${label} is invalid`);
  if ((value[0] & 0x80) !== 0) {
    const bits = BigInt(value.length * 8 - 1);
    let parsed = BigInt(value[0] & 0x7f);
    for (const byte of value.subarray(1)) parsed = (parsed << 8n) | BigInt(byte);
    if ((value[0] & 0x40) !== 0) parsed -= 1n << bits;
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`provider-host tar ${label} is out of range`);
    }
    return Number(parsed);
  }
  let start = 0;
  while (start < value.length && (value[start] === 0 || value[start] === 0x20)) start += 1;
  let end = start;
  while (end < value.length && value[end] >= 0x30 && value[end] <= 0x37) end += 1;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error(`provider-host tar ${label} is invalid`);
  }
  if (start === end) return 0;
  const parsed = Number.parseInt(value.subarray(start, end).toString("ascii"), 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`provider-host tar ${label} is out of range`);
  return parsed;
}

function parseTarString(value) {
  const terminator = value.indexOf(0);
  const end = terminator < 0 ? value.length : terminator;
  for (const byte of value.subarray(end)) {
    if (byte !== 0 && byte !== 0x20) throw new Error("provider-host tar string field is invalid");
  }
  const content = value.subarray(0, end);
  if ([...content].some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error("provider-host tar contains a non-ASCII path");
  }
  return content.toString("ascii");
}

function validateTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("provider-host tar checksum is invalid");
}

function parsePaxRecords(payload) {
  const records = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0 || space === offset) throw new Error("provider-host tar PAX metadata is invalid");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]{0,6}$/u.test(lengthText)) throw new Error("provider-host tar PAX metadata is invalid");
    const length = Number.parseInt(lengthText, 10);
    if (length < space - offset + 4 || offset + length > payload.length || payload[offset + length - 1] !== 0x0a) {
      throw new Error("provider-host tar PAX metadata is invalid");
    }
    const record = payload.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("provider-host tar PAX metadata is invalid");
    const key = record.subarray(0, equals).toString("ascii");
    const value = record.subarray(equals + 1).toString("utf8");
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || records.has(key) || value.includes("\u0000") ||
      key.startsWith("GNU.sparse") || key === "SCHILY.realsize" || key === "linkpath" ||
      !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset", "comment"].includes(key)) {
      throw new Error("provider-host tar PAX metadata is unsupported");
    }
    records.set(key, value);
    offset += length;
  }
  return records;
}

class BoundedTarReader {
  constructor(stream) {
    this.stream = stream;
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
    this.produced = 0;
  }

  async pull() {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buffer = next.value;
    this.offset = 0;
    this.produced += next.value.length;
    if (this.produced > maximumTarStreamBytes) {
      throw new Error("provider-host tar stream exceeds the verification ceiling");
    }
    return true;
  }

  async read(length, allowEnd = false) {
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffer.length && !await this.pull()) {
        if (allowEnd && written === 0) return null;
        throw new Error("provider-host tar stream is truncated");
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
      if (this.offset >= this.buffer.length && !await this.pull()) {
        throw new Error("provider-host tar stream is truncated");
      }
      const available = Math.min(remaining, this.buffer.length - this.offset);
      this.offset += available;
      remaining -= available;
    }
  }
}

async function inspectTarArchive(archive) {
  const source = createReadStream(archive);
  const gunzip = createGunzip();
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new BoundedTarReader(gunzip);
  const names = new Set();
  const foldedNames = new Set();
  const archiveNames = [];
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
        if (!second.every((byte) => byte === 0)) throw new Error("provider-host tar end marker is invalid");
        sawEnd = true;
        while (true) {
          const padding = await reader.read(512, true);
          if (padding === null) break;
          if (!padding.every((byte) => byte === 0)) throw new Error("provider-host tar has trailing data");
        }
        break;
      }
      validateTarChecksum(header);
      entryCount += 1;
      if (entryCount > maximumArchiveEntries) throw new Error("provider-host archive contains too many entries");
      const headerName = parseTarString(header.subarray(0, 100));
      const prefix = parseTarString(header.subarray(345, 500));
      const linkName = parseTarString(header.subarray(157, 257));
      const typeByte = header[156];
      const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const headerSize = parseTarNumber(header.subarray(124, 136), "size");
      metadataBytes += Buffer.byteLength(headerName) + Buffer.byteLength(prefix) + Buffer.byteLength(linkName);
      if (metadataBytes > maximumArchiveMetadataBytes) throw new Error("provider-host archive metadata exceeds the ceiling");

      if (type === "x" || type === "L") {
        if (headerSize > maximumArchiveMetadataBytes - metadataBytes) {
          throw new Error("provider-host archive metadata exceeds the ceiling");
        }
        const payload = await reader.read(headerSize);
        await reader.skip((512 - (headerSize % 512)) % 512);
        metadataBytes += headerSize;
        if (type === "x") {
          if (pendingPax !== null) throw new Error("provider-host tar has ambiguous PAX metadata");
          pendingPax = parsePaxRecords(payload);
        } else {
          if (pendingLongName !== null) throw new Error("provider-host tar has ambiguous GNU metadata");
          let end = payload.length;
          while (end > 0 && payload[end - 1] === 0) end -= 1;
          pendingLongName = asciiArchiveName(payload.subarray(0, end));
        }
        continue;
      }
      if (type === "g") throw new Error("provider-host tar global PAX metadata is unsupported");
      if (["1", "2", "3", "4", "6", "K", "S"].includes(type)) {
        throw new Error("provider-host archive contains a link or special entry");
      }
      if (!["0", "5"].includes(type)) throw new Error("provider-host tar entry type is unsupported");
      if (pendingPax !== null && pendingLongName !== null) {
        throw new Error("provider-host tar path metadata is ambiguous");
      }
      if (linkName !== "") throw new Error("provider-host tar regular entry has link metadata");
      const paxPath = pendingPax?.get("path");
      const joinedHeaderName = prefix ? `${prefix}/${headerName}` : headerName;
      const name = paxPath ?? pendingLongName ?? joinedHeaderName;
      let size = headerSize;
      if (pendingPax?.has("size")) {
        const value = pendingPax.get("size");
        if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) throw new Error("provider-host tar PAX size is invalid");
        const parsed = BigInt(value);
        if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("provider-host tar PAX size is out of range");
        size = Number(parsed);
      }
      pendingPax = null;
      pendingLongName = null;
      if (typeof name !== "string" || !safeArchiveEntry(name)) {
        throw new Error("provider-host archive contains an unsafe path");
      }
      if (![...Buffer.from(name, "utf8")].every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        throw new Error("provider-host tar contains a non-ASCII path");
      }
      const canonicalName = name.endsWith("/") ? name.slice(0, -1) : name;
      const foldedName = canonicalName.toLowerCase();
      if (names.has(canonicalName) || foldedNames.has(foldedName)) {
        throw new Error("provider-host archive contains duplicate paths");
      }
      names.add(canonicalName);
      foldedNames.add(foldedName);
      const directory = type === "5";
      if (directory !== name.endsWith("/") || (directory && size !== 0)) {
        throw new Error("provider-host tar entry type is inconsistent");
      }
      if (!directory) {
        extractedBytes += size;
        if (extractedBytes > maximumExtractedBytes) {
          throw new Error("provider-host archive exceeds the extracted-size ceiling");
        }
      }
      archiveNames.push(canonicalName);
      await reader.skip(size);
      await reader.skip((512 - (size % 512)) % 512);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("provider-host")) throw error;
    throw new Error("provider-host tar stream is invalid");
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (!sawEnd || pendingPax !== null || pendingLongName !== null || archiveNames.length < 1) {
    throw new Error("provider-host tar termination is invalid");
  }
  const roots = new Set(archiveNames.map((name) => name.split("/", 1)[0]));
  if (roots.size !== 1) throw new Error("provider-host archive root is invalid");
  return [...roots][0];
}

async function inspectArchive(archive) {
  const archiveInfo = await stat(archive);
  if (!archiveInfo.isFile() || archiveInfo.size < 1 || archiveInfo.size > maximumArchiveBytes) {
    throw new Error("provider-host archive is invalid or exceeds the verification ceiling");
  }
  if (archive.endsWith(".zip")) return await inspectZipArchive(archive, archiveInfo);
  if (archive.endsWith(".tar.gz")) return await inspectTarArchive(archive);
  throw new Error("provider-host archive format is unsupported");
}

function validateDependency(name, dependency, expectedArchives) {
  if (!exactKeys(dependency, ["version", "artifacts"]) || !/^\d+\.\d+\.\d+$/u.test(dependency.version) ||
    !exactKeys(dependency.artifacts, ["darwin-arm64", "linux-amd64"])) {
    throw new Error(`${name} dependency metadata is invalid`);
  }
  for (const [target, artifact] of Object.entries(dependency.artifacts)) {
    if (!exactKeys(artifact, ["url", "sha256", "archive"]) ||
      typeof artifact.url !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      artifact.archive !== expectedArchives[target]) {
      throw new Error(`${name} dependency artifact metadata is invalid`);
    }
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !approvedDownloadHosts.has(url.hostname)) {
      throw new Error(`${name} dependency URL is invalid`);
    }
  }
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readBinaryHeader(file, bytes = 4096) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isELFAmd64(header) {
  return header.length >= 20 && header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF" &&
    header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 0x3e;
}

function isMachOArm64(header) {
  if (header.length < 8) return false;
  if (header.readUInt32LE(0) === 0xfeedfacf) return header.readUInt32LE(4) === 0x0100000c;
  if (header.readUInt32BE(0) === 0xfeedfacf) return header.readUInt32BE(4) === 0x0100000c;
  const magic = header.readUInt32BE(0);
  const fat64 = magic === 0xcafebabf;
  if (magic !== 0xcafebabe && !fat64) return false;
  const count = header.readUInt32BE(4);
  const entryBytes = fat64 ? 32 : 20;
  if (count < 1 || count > 32 || header.length < 8 + count * entryBytes) return false;
  for (let index = 0; index < count; index += 1) {
    if (header.readUInt32BE(8 + index * entryBytes) === 0x0100000c) return true;
  }
  return false;
}

function isMachO(header) {
  if (header.length < 4) return false;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf,
    0xbebafeca, 0xbfbafeca].includes(header.readUInt32BE(0));
}

async function validateNativeFiles(root, manifest) {
  const mac = manifest.platform === "darwin";
  const prefix = mac ? "MultiVibe Host.app/Contents/" : "";
  const explicit = mac ? [
    `${prefix}Frameworks/node`, `${prefix}Helpers/ollama-runtime/ollama`, `${prefix}Helpers/ollama-runtime/llama-server`,
    `${prefix}Helpers/ollama-runtime/llama-quantize`, `${prefix}Helpers/multivibe-provider-agent`,
    `${prefix}Helpers/multivibe-runtime-benchmark`,
    `${prefix}MacOS/multivibe-host`,
  ] : ["bin/node", "runtime/ollama/bin/ollama", "bin/multivibe-provider-agent", "bin/multivibe-runtime-benchmark", "bin/multivibe-host"];
  const runtimePrefix = mac ? `${prefix}Helpers/ollama-runtime/` : "runtime/ollama/";
  const native = manifest.files.filter((entry) => explicit.includes(entry.path) ||
    (mac ? /\.(?:dylib|node|so)$/u.test(entry.path) : /(?:\.node|\.so(?:\.|$))/u.test(entry.path)) ||
    (entry.path.startsWith(runtimePrefix) && (entry.mode & 0o111) !== 0));
  for (const entry of native) {
    const header = await readBinaryHeader(path.join(root, entry.path));
    const valid = mac ? (isMachO(header) && (entry.path.startsWith(runtimePrefix) && !explicit.includes(entry.path) || isMachOArm64(header))) :
      isELFAmd64(header);
    if (!valid) {
      throw new Error(`provider-host native file has the wrong architecture: ${entry.path}`);
    }
  }
}

function parseCatalogHex(value, maximum) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,16}$/u.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= 1n && parsed <= maximum ? parsed : null;
}

export async function validateProviderModelCatalogAssessments(root, platform, declaredFiles = null) {
  const relativeCatalog = platform === "darwin" ?
    "MultiVibe Host.app/Contents/Resources/provider/provider-model-catalog.json" :
    "resources/provider/provider-model-catalog.json";
  const catalogPath = path.join(root, ...relativeCatalog.split("/"));
  const catalogInfo = await lstat(catalogPath);
  if (!catalogInfo.isFile() || catalogInfo.isSymbolicLink() || catalogInfo.size < 1 || catalogInfo.size > 1024 * 1024) {
    throw new Error("provider model catalog must be a bounded regular file");
  }
  const raw = await readFile(catalogPath, "utf8");
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    throw new Error("provider model catalog JSON is invalid");
  }
  if (!exactKeys(catalog, ["schema_version", "models"]) || catalog.schema_version !== "provider-model-catalog-v1" ||
    !Array.isArray(catalog.models) || catalog.models.length < 1 || catalog.models.length > 64) {
    throw new Error("provider model catalog schema is invalid");
  }
  const modelIDs = new Set();
  const ollamaModels = new Set();
  const manifestPaths = new Set();
  const assessmentFiles = new Set();
  let previousModelID = "";
  for (const model of catalog.models) {
    if (!exactKeys(model, ["canonical_model_id", "ollama_model", "ollama_manifest_path", "content_digest",
      "download_bytes_hex", "gpu_utilization_percent", "vram_estimates", "license"]) ||
      typeof model.canonical_model_id !== "string" ||
      !/^(?:hf|openrouter):[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/u.test(model.canonical_model_id) ||
      model.canonical_model_id <= previousModelID || modelIDs.has(model.canonical_model_id) ||
      typeof model.ollama_model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/u.test(model.ollama_model) ||
      ollamaModels.has(model.ollama_model) || typeof model.ollama_manifest_path !== "string" ||
      model.ollama_manifest_path.length > 256 || !safeRelative(model.ollama_manifest_path) ||
      manifestPaths.has(model.ollama_manifest_path) || typeof model.content_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(model.content_digest) ||
      parseCatalogHex(model.download_bytes_hex, 32n * 1024n * 1024n * 1024n * 1024n) === null ||
      !Number.isSafeInteger(model.gpu_utilization_percent) || model.gpu_utilization_percent < 1 ||
      model.gpu_utilization_percent > 100 || !Array.isArray(model.vram_estimates) ||
      model.vram_estimates.length < 1 || model.vram_estimates.length > 7 ||
      !exactKeys(model.license, ["license_id", "hosted_inference_allowed", "assessment_path", "assessment_digest"]) ||
      typeof model.license.license_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(model.license.license_id) ||
      model.license.hosted_inference_allowed !== true || typeof model.license.assessment_digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(model.license.assessment_digest) || typeof model.license.assessment_path !== "string" ||
      !safeRelative(model.license.assessment_path) || model.license.assessment_path.length > 256 ||
      !model.license.assessment_path.startsWith("provider-model-license-assessments/") ||
      !model.license.assessment_path.endsWith(".md")) {
      throw new Error("provider model catalog entry is invalid");
    }
    modelIDs.add(model.canonical_model_id);
    ollamaModels.add(model.ollama_model);
    manifestPaths.add(model.ollama_manifest_path);
    previousModelID = model.canonical_model_id;
    let previousContext = 0;
    for (const estimate of model.vram_estimates) {
      if (!exactKeys(estimate, ["context_tokens", "estimated_vram_bytes_hex"]) ||
        ![2048, 4096, 8192, 16384, 32768, 65536, 131072].includes(estimate.context_tokens) ||
        estimate.context_tokens <= previousContext ||
        parseCatalogHex(estimate.estimated_vram_bytes_hex, 4n * 1024n * 1024n * 1024n * 1024n) === null) {
        throw new Error("provider model catalog VRAM estimate is invalid");
      }
      previousContext = estimate.context_tokens;
    }
    const assessmentRelative = `THIRD_PARTY/${model.license.assessment_path}`;
    if (declaredFiles !== null && !declaredFiles.has(assessmentRelative)) {
      throw new Error("provider model license assessment is absent from the signed manifest");
    }
    const assessmentPath = path.join(root, ...assessmentRelative.split("/"));
    const assessmentInfo = await lstat(assessmentPath);
    if (!assessmentInfo.isFile() || assessmentInfo.isSymbolicLink() || assessmentInfo.size < 1 ||
      assessmentInfo.size > maximumArchiveMetadataBytes || await sha256(assessmentPath) !== model.license.assessment_digest) {
      throw new Error(`provider model license assessment digest mismatch: ${model.license.assessment_path}`);
    }
    assessmentFiles.add(assessmentRelative);
  }
  if (declaredFiles !== null) {
    const declaredAssessments = [...declaredFiles].filter((file) =>
      file.startsWith("THIRD_PARTY/provider-model-license-assessments/"));
    if (declaredAssessments.length !== assessmentFiles.size ||
      declaredAssessments.some((file) => !assessmentFiles.has(file))) {
      throw new Error("provider model license assessments and catalog differ");
    }
  }
}

function validRuntimeDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validRuntimeSlug(value, maximum = 64) {
  return typeof value === "string" && value.length <= maximum && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validRuntimeLicense(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(value);
}

function validBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validRuntimeHTTPSURL(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash &&
      parsed.hostname.length > 0 && parsed.pathname.length <= 2048 && !/[\0-\x1f\x7f]/u.test(value);
  } catch {
    return false;
  }
}

async function readProviderJSON(root, relative) {
  const filePath = path.join(root, ...relative.split("/"));
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > maximumArchiveMetadataBytes) {
    throw new Error(`provider runtime resource must be a bounded regular file: ${relative}`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`provider runtime resource JSON is invalid: ${relative}`);
  }
}

function goJSON(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function runtimeProfileDigest(profile) {
  const material = {
    schema_version: profile.schema_version,
    id: profile.id,
    profile_digest: "",
    priority: profile.priority,
    model: {
      id: profile.model.id,
      content_digest: profile.model.content_digest,
      format: profile.model.format,
      quantization: profile.model.quantization,
      artifact_bytes: profile.model.artifact_bytes,
      license: profile.model.license,
      hosted_inference_allowed: profile.model.hosted_inference_allowed,
      license_assessment_digest: profile.model.license_assessment_digest,
    },
    hardware: {
      class: profile.hardware.class,
      os: profile.hardware.os,
      architecture: profile.hardware.architecture,
      accelerator_kind: profile.hardware.accelerator_kind,
      minimum_accelerator_memory_bytes: profile.hardware.minimum_accelerator_memory_bytes,
      unified_memory: profile.hardware.unified_memory,
    },
    runtime: {
      backend_id: profile.runtime.backend_id,
      contract_version: profile.runtime.contract_version,
      adapter_version: profile.runtime.adapter_version,
      runtime_artifact_digest: profile.runtime.runtime_artifact_digest,
    },
    tuning: {
      context_tokens: profile.tuning.context_tokens,
      batch_size: profile.tuning.batch_size,
      parallelism: profile.tuning.parallelism,
      gpu_offload_layers: profile.tuning.gpu_offload_layers,
      estimated_memory_bytes: profile.tuning.estimated_memory_bytes,
      reserve_memory_bytes: profile.tuning.reserve_memory_bytes,
    },
    provenance: {
      recommendation_source_url: profile.provenance.recommendation_source_url,
      recommendation_digest: profile.provenance.recommendation_digest,
      method: profile.provenance.method,
      license: profile.provenance.license,
    },
  };
  return `sha256:${createHash("sha256").update(goJSON(material)).digest("hex")}`;
}

function runtimeCatalogDigest(catalog) {
  const provenance = {
    source_url: catalog.provenance.source_url,
    source_digest: catalog.provenance.source_digest,
  };
  if (catalog.provenance.migrated_from) provenance.migrated_from = catalog.provenance.migrated_from;
  const material = {
    schema_version: catalog.schema_version,
    format: catalog.format,
    license: catalog.license,
    provenance,
    profiles: catalog.profiles.map((profile) => ({ id: profile.id, digest: profile.profile_digest })),
  };
  return `sha256:${createHash("sha256").update(goJSON(material)).digest("hex")}`;
}

function validateRuntimeProfile(profile, modelByID, modelCatalogDigest) {
  const maximumMemory = 2 ** 50;
  if (!exactKeys(profile, ["schema_version", "id", "profile_digest", "priority", "model", "hardware", "runtime", "tuning", "provenance"]) ||
    profile.schema_version !== "provider-runtime-profile-v3" || !validRuntimeSlug(profile.id, 128) ||
    !validRuntimeDigest(profile.profile_digest) || profile.profile_digest !== runtimeProfileDigest(profile) ||
    !validBoundedInteger(profile.priority, 1, 65535) ||
    !exactKeys(profile.model, ["id", "content_digest", "format", "quantization", "artifact_bytes", "license",
      "hosted_inference_allowed", "license_assessment_digest"]) ||
    typeof profile.model.id !== "string" || !/^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/u.test(profile.model.id) ||
    !validRuntimeDigest(profile.model.content_digest) || !validRuntimeSlug(profile.model.format) ||
    !validRuntimeSlug(profile.model.quantization) || !validBoundedInteger(profile.model.artifact_bytes, 1, maximumMemory) ||
    !validRuntimeLicense(profile.model.license) || profile.model.hosted_inference_allowed !== true ||
    !validRuntimeDigest(profile.model.license_assessment_digest) ||
    !exactKeys(profile.hardware, ["class", "os", "architecture", "accelerator_kind", "minimum_accelerator_memory_bytes", "unified_memory"]) ||
    !validRuntimeSlug(profile.hardware.class) || !validRuntimeSlug(profile.hardware.os) ||
    !validRuntimeSlug(profile.hardware.architecture) || !validRuntimeSlug(profile.hardware.accelerator_kind) ||
    !validBoundedInteger(profile.hardware.minimum_accelerator_memory_bytes, 1, maximumMemory) ||
    typeof profile.hardware.unified_memory !== "boolean" ||
    !exactKeys(profile.runtime, ["backend_id", "contract_version", "adapter_version", "runtime_artifact_digest"]) ||
    !validRuntimeSlug(profile.runtime.backend_id) || !validRuntimeSlug(profile.runtime.contract_version, 128) ||
    !validRuntimeSlug(profile.runtime.adapter_version, 128) || !validRuntimeDigest(profile.runtime.runtime_artifact_digest) ||
    !exactKeys(profile.tuning, ["context_tokens", "batch_size", "parallelism", "gpu_offload_layers", "estimated_memory_bytes", "reserve_memory_bytes"]) ||
    !validBoundedInteger(profile.tuning.context_tokens, 1, 1048576) ||
    !validBoundedInteger(profile.tuning.batch_size, 1, 4096) ||
    !validBoundedInteger(profile.tuning.parallelism, 1, 256) ||
    !validBoundedInteger(profile.tuning.gpu_offload_layers, 0, 4096) ||
    !validBoundedInteger(profile.tuning.estimated_memory_bytes, 1, maximumMemory) ||
    !validBoundedInteger(profile.tuning.reserve_memory_bytes, 1, maximumMemory) ||
    profile.tuning.estimated_memory_bytes + profile.tuning.reserve_memory_bytes > profile.hardware.minimum_accelerator_memory_bytes ||
    !exactKeys(profile.provenance, ["recommendation_source_url", "recommendation_digest", "method", "license"]) ||
    !validRuntimeHTTPSURL(profile.provenance.recommendation_source_url) ||
    profile.provenance.recommendation_digest !== modelCatalogDigest || !validRuntimeSlug(profile.provenance.method) ||
    !validRuntimeLicense(profile.provenance.license)) {
    throw new Error("provider runtime profile is invalid");
  }
  const model = modelByID.get(profile.model.id);
  if (!model || model.content_digest !== profile.model.content_digest ||
    parseCatalogHex(model.download_bytes_hex, BigInt(maximumMemory)) !== BigInt(profile.model.artifact_bytes) ||
    model.license.license_id !== profile.model.license || model.license.hosted_inference_allowed !== true ||
    `sha256:${model.license.assessment_digest}` !== profile.model.license_assessment_digest) {
    throw new Error("provider runtime profile and model catalog differ");
  }
}

function validateRuntimeSchema(schema, name) {
  const expectedID = `https://multivibe.cloud/schemas/${name}`;
  const expectedKeys = name === "provider-runtime-benchmark-result.schema.json" ?
    ["$schema", "$id", "title", "type", "additionalProperties", "required", "properties", "allOf", "$defs"] :
    name === "provider-runtime-benchmark-spec.schema.json" || name === "provider-runtime-profiles.schema.json" ?
      ["$schema", "$id", "title", "type", "additionalProperties", "required", "properties", "$defs"] :
      ["$schema", "$id", "title", "type", "additionalProperties", "required", "properties"];
  if (!exactKeys(schema, expectedKeys) || schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.$id !== expectedID || schema.type !== "object" || schema.additionalProperties !== false ||
    !Array.isArray(schema.required) || schema.required.length < 1 || new Set(schema.required).size !== schema.required.length ||
    !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties) ||
    schema.required.some((property) => !Object.hasOwn(schema.properties, property))) {
    throw new Error(`provider runtime schema is invalid: ${name}`);
  }
  if (name === "provider-runtime-profiles.schema.json" &&
    (schema.properties.schema_version?.const !== "provider-runtime-profile-catalog-v3" || schema.properties.profiles?.minItems !== 1)) {
    throw new Error(`provider runtime schema is incomplete: ${name}`);
  }
  if (name === "provider-runtime-profile-overrides.schema.json" &&
    schema.properties.schema_version?.const !== "provider-runtime-profile-overrides-v1") {
    throw new Error(`provider runtime schema is incomplete: ${name}`);
  }
  if (name === "provider-runtime-benchmark-spec.schema.json" &&
    (schema.properties.schema_version?.const !== "provider-runtime-benchmark-spec-v1" ||
      schema.properties.dataset?.const !== "multivibe-synthetic-term-sequence-v1" ||
      !schema.required.includes("requested_runtime_settings") || !schema.required.includes("synthetic_terms"))) {
    throw new Error(`provider runtime schema is incomplete: ${name}`);
  }
  if (name === "provider-runtime-benchmark-result.schema.json" &&
    (schema.properties.schema_version?.const !== "provider-runtime-benchmark-result-v1" ||
      schema.properties.pass_scope?.const !== "synthetic-runtime-execution-only" ||
      schema.properties.profile_compatibility_attested?.const !== false ||
      !schema.required.includes("runtime_settings_measurement") || !schema.required.includes("observed_prompt_tokens") ||
      !schema.$defs?.memory?.required?.includes("sampled_peak_bytes") ||
      !schema.$defs?.memory?.required?.includes("samples_per_run"))) {
    throw new Error(`provider runtime schema is incomplete: ${name}`);
  }
  if (name === "provider-runtime-benchmark-store.schema.json" &&
    (schema.properties.schema_version?.const !== "provider-runtime-benchmark-store-v1" ||
      schema.properties.results?.maxItems !== 256 ||
      schema.properties.results?.items?.$ref !== "provider-runtime-benchmark-result.schema.json")) {
    throw new Error(`provider runtime schema is incomplete: ${name}`);
  }
}

export async function validateProviderRuntimeResources(root, platform) {
  const prefix = platform === "darwin" ? "MultiVibe Host.app/Contents/Resources/provider" : "resources/provider";
  const modelCatalogRelative = `${prefix}/provider-model-catalog.json`;
  const modelCatalogPath = path.join(root, ...modelCatalogRelative.split("/"));
  const modelCatalog = await readProviderJSON(root, modelCatalogRelative);
  const modelCatalogRaw = await readFile(modelCatalogPath);
  const modelByID = new Map(modelCatalog.models.map((model) => [model.canonical_model_id, model]));
  if (modelByID.size !== modelCatalog.models.length) throw new Error("provider model catalog contains duplicate IDs");
  const modelCatalogDigest = `sha256:${createHash("sha256").update(modelCatalogRaw).digest("hex")}`;

  const catalog = await readProviderJSON(root, `${prefix}/provider-runtime-profiles.json`);
  const provenanceKeys = catalog?.provenance?.migrated_from ? ["source_url", "source_digest", "migrated_from"] :
    ["source_url", "source_digest"];
  if (!exactKeys(catalog, ["schema_version", "format", "catalog_digest", "license", "provenance", "profiles"]) ||
    catalog.schema_version !== "provider-runtime-profile-catalog-v3" || catalog.format !== "multivibe-runtime-profile-catalog" ||
    !validRuntimeDigest(catalog.catalog_digest) || !validRuntimeLicense(catalog.license) ||
    !exactKeys(catalog.provenance, provenanceKeys) || !validRuntimeHTTPSURL(catalog.provenance.source_url) ||
    catalog.provenance.source_digest !== modelCatalogDigest ||
    (catalog.provenance.migrated_from !== undefined && catalog.provenance.migrated_from !== "provider-runtime-workload-profile-v2") ||
    !Array.isArray(catalog.profiles) || catalog.profiles.length < 1 || catalog.profiles.length > 512) {
    throw new Error("provider runtime profile catalog is invalid");
  }
  let previousID = "";
  for (const profile of catalog.profiles) {
    if (typeof profile.id !== "string" || profile.id <= previousID) throw new Error("provider runtime profiles are not uniquely sorted");
    validateRuntimeProfile(profile, modelByID, modelCatalogDigest);
    previousID = profile.id;
  }
  if (catalog.catalog_digest !== runtimeCatalogDigest(catalog)) {
    throw new Error("provider runtime profile catalog digest mismatch");
  }

  const schemaNames = [
    "provider-runtime-profiles.schema.json",
    "provider-runtime-profile-overrides.schema.json",
    "provider-runtime-benchmark-spec.schema.json",
    "provider-runtime-benchmark-result.schema.json",
    "provider-runtime-benchmark-store.schema.json",
  ];
  for (const name of schemaNames) {
    validateRuntimeSchema(await readProviderJSON(root, `${prefix}/schemas/${name}`), name);
  }

  const overrides = await readProviderJSON(root, `${prefix}/examples/runtime-profile-overrides.json`);
  const overrideKeys = ["schema_version", "require_profile_id", "require_backend_id", "context_tokens", "batch_size",
    "parallelism", "gpu_offload_layers", "maximum_memory_bytes"];
  if (!exactKeys(overrides, overrideKeys) || overrides.schema_version !== "provider-runtime-profile-overrides-v1" ||
    !validRuntimeSlug(overrides.require_profile_id, 128) || !validRuntimeSlug(overrides.require_backend_id) ||
    !validBoundedInteger(overrides.context_tokens, 1, 1048576) || !validBoundedInteger(overrides.batch_size, 1, 4096) ||
    !validBoundedInteger(overrides.parallelism, 1, 256) || !validBoundedInteger(overrides.gpu_offload_layers, 0, 4096) ||
    !validBoundedInteger(overrides.maximum_memory_bytes, 1, 2 ** 50)) {
    throw new Error("provider runtime override example is invalid");
  }

  const benchmark = await readProviderJSON(root, `${prefix}/examples/runtime-benchmark-spec.json`);
  const benchmarkKeys = ["schema_version", "enabled", "benchmark_id", "profile_id", "profile_digest", "catalog_digest",
    "model_id", "model_content_digest", "hardware_class", "runtime_id", "dataset", "runs", "warmup_runs",
    "synthetic_terms", "maximum_output_tokens", "requested_runtime_settings", "seed", "temperature_milli",
    "run_timeout_milliseconds", "induce_oom"];
  if (!exactKeys(benchmark, benchmarkKeys) || benchmark.schema_version !== "provider-runtime-benchmark-spec-v1" ||
    benchmark.enabled !== false || benchmark.runtime_id !== "ollama-managed" ||
    benchmark.dataset !== "multivibe-synthetic-term-sequence-v1" || benchmark.seed !== 7 ||
    benchmark.temperature_milli !== 0 || benchmark.induce_oom !== false ||
    !exactKeys(benchmark.requested_runtime_settings, ["context_tokens", "batch_size", "parallelism", "gpu_offload_layers"]) ||
    !validBoundedInteger(benchmark.synthetic_terms, 32, 8192) ||
    !validBoundedInteger(benchmark.maximum_output_tokens, 8, 2048) ||
    !validBoundedInteger(benchmark.requested_runtime_settings.context_tokens, 1, 1048576) ||
    !validBoundedInteger(benchmark.requested_runtime_settings.batch_size, 1, 4096) ||
    benchmark.requested_runtime_settings.parallelism !== 1 ||
    !validBoundedInteger(benchmark.requested_runtime_settings.gpu_offload_layers, 1, 4096)) {
    throw new Error("provider runtime benchmark example is invalid");
  }
}

async function validateTree(root, options, archiveRoot) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("provider-host directory is invalid");
  const manifestPath = path.join(root, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(manifestRaw) > 4 * 1024 * 1024) throw new Error("provider-host manifest is too large");
  const manifest = JSON.parse(manifestRaw);
  const manifestKeys = ["schemaVersion", "product", "version", "sourceCommit", "platform", "architecture",
    "sourceTreeDirty", "releaseReady", "macOSSignature", "node", "managedRuntime", "files"];
  const targetIsValid = (manifest.platform === "darwin" && manifest.architecture === "arm64") ||
    (manifest.platform === "linux" && manifest.architecture === "amd64");
  if (!exactKeys(manifest, manifestKeys) || manifest.schemaVersion !== 1 || manifest.product !== "multivibe-host" ||
    typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    typeof manifest.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.sourceCommit) ||
    !targetIsValid || typeof manifest.sourceTreeDirty !== "boolean" || typeof manifest.releaseReady !== "boolean" ||
    !Array.isArray(manifest.files) || manifest.files.length < 12 || manifest.files.length > 100_000) {
    throw new Error("provider-host manifest schema is invalid");
  }
  const expectedMacSignature = manifest.platform === "darwin";
  if ((expectedMacSignature && !["unsigned-development", "developer-id", "developer-id-notarized"].includes(manifest.macOSSignature)) ||
    (!expectedMacSignature && manifest.macOSSignature !== null) || manifest.releaseReady !== (!manifest.sourceTreeDirty &&
      (manifest.platform !== "darwin" || manifest.macOSSignature === "developer-id-notarized"))) {
    throw new Error("provider-host release-readiness metadata is inconsistent");
  }
  validateDependency("Node", manifest.node, { "darwin-arm64": "tar-gzip", "linux-amd64": "tar-gzip" });
  validateDependency("Ollama", manifest.managedRuntime, { "darwin-arm64": "tar-gzip", "linux-amd64": "tar-zstd" });

  if (archiveRoot) {
    const expectedRoot = `multivibe-host_${manifest.version}_${manifest.platform}_${manifest.architecture}`;
    if (archiveRoot !== expectedRoot || path.basename(root) !== expectedRoot) throw new Error("provider-host archive name is inconsistent");
  }

  const seen = new Set();
  let previous = "";
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ["path", "size", "mode", "sha256"]) || !safeRelative(entry.path) || seen.has(entry.path) ||
      (previous && previous.localeCompare(entry.path) >= 0) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      entry.size > maximumArchiveBytes || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("provider-host manifest entry is invalid");
    }
    previous = entry.path;
    seen.add(entry.path);
    const file = path.join(root, entry.path);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || (info.mode & 0o777) !== entry.mode ||
      await sha256(file) !== entry.sha256) {
      throw new Error(`provider-host file verification failed: ${entry.path}`);
    }
  }

  const actualFiles = await allFiles(root);
  const expectedFiles = [...seen, "manifest.json"].sort((left, right) => left.localeCompare(right));
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("provider-host archive contains files outside the signed manifest");
  }
  await validateProviderModelCatalogAssessments(root, manifest.platform, seen);
  await validateProviderRuntimeResources(root, manifest.platform);

  const macPrefix = "MultiVibe Host.app/Contents";
  const required = ["LICENSE", "NOTICE", "README.md", "install.sh", "uninstall.sh", "THIRD_PARTY/node-LICENSE",
    "THIRD_PARTY/ollama-LICENSE", "THIRD_PARTY/provider-host-dependencies.json"];
  if (manifest.platform === "darwin") required.push(
    `${macPrefix}/Frameworks/node`, `${macPrefix}/Helpers/ollama-runtime/ollama`, `${macPrefix}/Helpers/ollama-runtime/llama-server`,
    `${macPrefix}/Helpers/ollama-runtime/llama-quantize`,
    `${macPrefix}/Helpers/ollama-runtime/.multivibe-bundle.json`, `${macPrefix}/Helpers/multivibe-provider-agent`,
    `${macPrefix}/Helpers/multivibe-runtime-benchmark`,
    `${macPrefix}/MacOS/multivibe-host`, `${macPrefix}/Resources/app/dist/server.js`,
    `${macPrefix}/Resources/app/dist/instrument.js`, `${macPrefix}/Resources/provider/provider-model-catalog.json`,
    `${macPrefix}/Resources/provider/provider-runtime-profiles.json`,
    `${macPrefix}/Resources/provider/schemas/provider-runtime-profiles.schema.json`,
    `${macPrefix}/Resources/provider/schemas/provider-runtime-profile-overrides.schema.json`,
    `${macPrefix}/Resources/provider/schemas/provider-runtime-benchmark-spec.schema.json`,
    `${macPrefix}/Resources/provider/schemas/provider-runtime-benchmark-result.schema.json`,
    `${macPrefix}/Resources/provider/schemas/provider-runtime-benchmark-store.schema.json`,
    `${macPrefix}/Resources/provider/examples/runtime-profile-overrides.json`,
    `${macPrefix}/Resources/provider/examples/runtime-benchmark-spec.json`,
    `${macPrefix}/Resources/provider/provider-host-dependencies.json`, `${macPrefix}/Resources/verify-provider-host.mjs`,
    `${macPrefix}/Info.plist`,
  );
  else required.push("bin/node", "runtime/ollama/bin/ollama", "runtime/ollama/.multivibe-bundle.json",
    "bin/multivibe-provider-agent", "bin/multivibe-runtime-benchmark", "bin/multivibe-host", "app/dist/server.js", "app/dist/instrument.js",
    "resources/provider/provider-model-catalog.json", "resources/provider/provider-runtime-profiles.json",
    "resources/provider/schemas/provider-runtime-profiles.schema.json",
    "resources/provider/schemas/provider-runtime-profile-overrides.schema.json",
    "resources/provider/schemas/provider-runtime-benchmark-spec.schema.json",
    "resources/provider/schemas/provider-runtime-benchmark-result.schema.json",
    "resources/provider/schemas/provider-runtime-benchmark-store.schema.json",
    "resources/provider/examples/runtime-profile-overrides.json",
    "resources/provider/examples/runtime-benchmark-spec.json",
    "resources/provider/provider-host-dependencies.json", "verify-provider-host.mjs");
  if (required.some((file) => !seen.has(file))) throw new Error("provider-host archive is missing a required file");
  if (manifest.platform === "darwin" && manifest.macOSSignature !== "unsigned-development" &&
    !seen.has(`${macPrefix}/_CodeSignature/CodeResources`)) {
    throw new Error("provider-host signed application metadata is missing");
  }

  const dependencyFile = JSON.parse(await readFile(path.join(root, "THIRD_PARTY", "provider-host-dependencies.json"), "utf8"));
  if (dependencyFile.schemaVersion !== 1 || canonicalJSON(dependencyFile.node) !== canonicalJSON(manifest.node) ||
    canonicalJSON(dependencyFile.ollama) !== canonicalJSON(manifest.managedRuntime)) {
    throw new Error("provider-host dependency metadata does not match the manifest");
  }
  const providerDependencyPath = manifest.platform === "darwin" ?
    path.join(root, macPrefix, "Resources", "provider", "provider-host-dependencies.json") :
    path.join(root, "resources", "provider", "provider-host-dependencies.json");
  if (canonicalJSON(JSON.parse(await readFile(providerDependencyPath, "utf8"))) !== canonicalJSON(dependencyFile)) {
    throw new Error("provider runtime dependency metadata is inconsistent");
  }
  const runtimeMarkerPath = manifest.platform === "darwin" ?
    path.join(root, macPrefix, "Helpers", "ollama-runtime", ".multivibe-bundle.json") :
    path.join(root, "runtime", "ollama", ".multivibe-bundle.json");
  const selectedTarget = `${manifest.platform}-${manifest.architecture}`;
  const marker = JSON.parse(await readFile(runtimeMarkerPath, "utf8"));
  if (!exactKeys(marker, ["schema_version", "version", "platform", "archive_sha256"]) ||
    marker.schema_version !== "managed-ollama-bundle-v1" || marker.version !== manifest.managedRuntime.version ||
    marker.platform !== selectedTarget || marker.archive_sha256 !== manifest.managedRuntime.artifacts[selectedTarget].sha256) {
    throw new Error("bundled Ollama runtime marker is invalid");
  }
  await validateNativeFiles(root, manifest);

  const application = manifest.platform === "darwin" ? path.join(root, "MultiVibe Host.app") : null;
  if (application && manifest.macOSSignature !== "unsigned-development" && process.platform === "darwin") {
    await command("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
    const signatureDetails = await command("codesign", ["-d", "--verbose=4", application], {
      capture: true,
      captureStderr: true,
      captureLimit: 64 * 1024,
    });
    const teamIdentifiers = signatureDetails.split("\n").map((line) => /^TeamIdentifier=(\S+)$/u.exec(line.trim()))
      .filter(Boolean).map((match) => match[1]);
    if (teamIdentifiers.length !== 1 || teamIdentifiers[0] !== expectedAppleTeamIdentifier) {
      throw new Error("provider-host macOS TeamIdentifier is invalid");
    }
    if (manifest.macOSSignature === "developer-id-notarized") {
      await command("xcrun", ["stapler", "validate", application]);
      await command("spctl", ["--assess", "--type", "execute", "--verbose=2", application]);
    }
  }

  const host = manifest.platform === "darwin" ? path.join(application, "Contents", "MacOS", "multivibe-host") : path.join(root, "bin", "multivibe-host");
  const agent = manifest.platform === "darwin" ? path.join(application, "Contents", "Helpers", "multivibe-provider-agent") : path.join(root, "bin", "multivibe-provider-agent");
  const benchmark = manifest.platform === "darwin" ? path.join(application, "Contents", "Helpers", "multivibe-runtime-benchmark") : path.join(root, "bin", "multivibe-runtime-benchmark");
  let profile = null;
  if (options.requireRuntime) {
    if (manifest.releaseReady !== true) {
      throw new Error("provider-host runtime verification requires a release-ready archive");
    }
    const nativeTarget = (manifest.platform === "darwin" && manifest.architecture === "arm64" && process.platform === "darwin" && process.arch === "arm64") ||
      (manifest.platform === "linux" && manifest.architecture === "amd64" && process.platform === "linux" && process.arch === "x64");
    if (!nativeTarget) throw new Error("provider-host runtime verification requires the matching target host");
    const hostVersion = await command(host, ["version"], { capture: true, captureLimit: 4096 });
    const agentVersion = await command(agent, ["version"], { capture: true, captureLimit: 4096 });
    const benchmarkVersion = await command(benchmark, ["version"], { capture: true, captureLimit: 4096 });
    if (hostVersion !== manifest.version || agentVersion !== manifest.version || benchmarkVersion !== manifest.version) {
      throw new Error("provider-host binary versions do not match the manifest");
    }
    const doctor = JSON.parse(await command(host, ["doctor"], { capture: true, captureLimit: 64 * 1024 }));
    if (doctor.schema_version !== "multivibe-host-doctor-v1" || doctor.version !== manifest.version ||
      doctor.bundle !== "valid" || doctor.platform?.supported !== true) {
      throw new Error("provider-host doctor did not confirm the bundle and hardware");
    }
    profile = doctor.platform.profile;
  }
  return { manifest, profile };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  let work = null;
  let root = options.directory;
  let archiveRoot = null;
  let verifiedArchiveSha256 = null;
  try {
    if (options.archive) {
      const inputInfo = await lstat(options.archive);
      if (!inputInfo.isFile() || inputInfo.isSymbolicLink() || inputInfo.size < 1 || inputInfo.size > maximumArchiveBytes) {
        throw new Error("provider-host archive is invalid or exceeds the verification ceiling");
      }
      work = await mkdtemp(path.join(tmpdir(), "multivibe-host-verify-"));
      await chmod(work, 0o700);
      const extension = options.archive.endsWith(".zip") ? ".zip" : options.archive.endsWith(".tar.gz") ? ".tar.gz" : null;
      if (extension === null) throw new Error("provider-host archive format is unsupported");
      const archiveCopy = path.join(work, `input${extension}`);
      await copyFile(options.archive, archiveCopy);
      await chmod(archiveCopy, 0o600);
      const copiedInfo = await lstat(archiveCopy);
      if (!copiedInfo.isFile() || copiedInfo.isSymbolicLink() || copiedInfo.size < 1 || copiedInfo.size > maximumArchiveBytes) {
        throw new Error("provider-host private archive copy is invalid or exceeds the verification ceiling");
      }
      verifiedArchiveSha256 = await sha256(archiveCopy);
      archiveRoot = await inspectArchive(archiveCopy);
      const extraction = path.join(work, "extracted");
      await mkdir(extraction, { mode: 0o700 });
      if (extension === ".zip") await command("unzip", ["-q", archiveCopy, "-d", extraction]);
      else await command("tar", ["-xzf", archiveCopy, "-C", extraction]);
      const entries = await readdir(extraction, { withFileTypes: true });
      if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink()) {
        throw new Error("provider-host archive root is invalid");
      }
      root = path.join(extraction, entries[0].name);
    }
    const { manifest, profile } = await validateTree(root, options, archiveRoot);
    console.log(JSON.stringify({
      verified: true,
      archive: options.archive ?? null,
      directory: options.directory ?? null,
      archiveSha256: verifiedArchiveSha256,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      sourceTreeDirty: manifest.sourceTreeDirty,
      releaseReady: manifest.releaseReady,
      platform: manifest.platform,
      architecture: manifest.architecture,
      runtimeChecked: options.requireRuntime,
      profile,
    }));
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`provider-host verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
