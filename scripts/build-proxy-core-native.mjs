import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const cargoTargetDirectory = process.env.CARGO_TARGET_DIR
  ? path.resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
  : path.join(repositoryRoot, "target");

const cargo = spawnSync(
  "cargo",
  ["build", "-p", "multivibe-proxy-core", ...(profile === "release" ? ["--release"] : [])],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const libraryName =
  process.platform === "win32"
    ? "multivibe_proxy_core.dll"
    : process.platform === "darwin"
      ? "libmultivibe_proxy_core.dylib"
      : "libmultivibe_proxy_core.so";
const source = path.join(cargoTargetDirectory, profile, libraryName);
const destinationDirectory = path.join(repositoryRoot, "native");
const destination = path.join(destinationDirectory, "multivibe-proxy-core.node");

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
console.log(`Built ${path.relative(repositoryRoot, destination)}`);
