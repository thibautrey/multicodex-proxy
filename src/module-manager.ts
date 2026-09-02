import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODULE_HOOKS,
  MULTIVIBE_MODULE_API_VERSION,
  type ModuleContext,
  type ModuleHookName,
  type ModuleHookResult,
  type ModuleManifest,
  type ModuleResponse,
  type MultivibeModule,
} from "./module-sdk.js";

const MANIFEST = "multivibe.module.json";
const LOCK_FILE = "modules-lock.json";
const MAX_REPOSITORY_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

export type ModuleLock = {
  id: string;
  origin: string;
  commit: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  source: "external" | "bundled";
  restartRequired?: boolean;
};

export type ModuleView = ModuleLock & {
  manifest?: ModuleManifest;
  loaded: boolean;
  healthy: boolean;
  error?: string;
  removable: boolean;
};

type LoadedModule = {
  lock: ModuleLock;
  manifest: ModuleManifest;
  implementation: MultivibeModule;
  healthy: boolean;
  error?: string;
};

export function normalizePublicGitHubUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("A public GitHub HTTPS repository URL is required");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only public https://github.com repositories are supported");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub repository URLs cannot contain credentials, query, or fragment");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) throw new Error("GitHub URL must contain owner and repository");
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/, "");
  const safe = /^[A-Za-z0-9_.-]+$/;
  if (!safe.test(owner) || !safe.test(repository) || !repository) {
    throw new Error("Invalid GitHub owner or repository name");
  }
  return `https://github.com/${owner}/${repository}.git`;
}

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(stderr.trim() || `${command} exited with ${code}`)),
    );
  });
}

async function validateTree(root: string): Promise<void> {
  let total = 0;
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const candidate = path.join(directory, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(candidate);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error(`Module symlink escapes repository: ${entry.name}`);
        }
      } else if (stat.isDirectory()) {
        await visit(candidate);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Module file is too large: ${entry.name}`);
        total += stat.size;
        if (total > MAX_REPOSITORY_BYTES) throw new Error("Module repository is too large");
      }
    }
  };
  await visit(root);
}

export async function readModuleManifest(root: string): Promise<ModuleManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), "utf8"));
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(manifest.id ?? "")) throw new Error("Invalid module id");
  if (manifest.apiVersion !== MULTIVIBE_MODULE_API_VERSION) throw new Error("Incompatible module API version");
  if (!Array.isArray(manifest.hooks) || manifest.hooks.some((hook: string) => !MODULE_HOOKS.includes(hook as ModuleHookName))) {
    throw new Error("Invalid module hooks");
  }
  const entrypoint = path.resolve(root, String(manifest.entrypoint ?? ""));
  if (!entrypoint.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Module entrypoint escapes repository");
  const stat = await fs.stat(entrypoint);
  if (!stat.isFile()) throw new Error("Module entrypoint is not a file");
  return manifest as ModuleManifest;
}

export class ModuleManager {
  private locks: ModuleLock[] = [];
  private loaded = new Map<string, LoadedModule>();

  constructor(
    private root: string,
    private bundledRoot?: string,
  ) {}

  private get lockPath() { return path.join(this.root, LOCK_FILE); }
  private get checkoutRoot() { return path.join(this.root, "checkouts"); }

  async initialize(): Promise<void> {
    await fs.mkdir(this.checkoutRoot, { recursive: true });
    try {
      this.locks = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.locks = [];
    }
    if (this.bundledRoot) {
      try {
        const manifest = await readModuleManifest(this.bundledRoot);
        if (!this.locks.some((entry) => entry.id === manifest.id)) {
          this.locks.push({
            id: manifest.id,
            origin: normalizePublicGitHubUrl(manifest.repository),
            commit: "bundled",
            enabled: true,
            settings: manifest.defaultSettings ?? {},
            source: "bundled",
          });
          await this.saveLocks();
        }
      } catch (error) {
        console.warn(`[modules] bundled security module unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const lock of this.locks.filter((entry) => entry.enabled && !entry.restartRequired)) {
      await this.load(lock);
    }
  }

  private moduleRoot(lock: ModuleLock): string {
    if (lock.source === "bundled" && this.bundledRoot) return this.bundledRoot;
    return path.join(this.checkoutRoot, lock.id);
  }

  private async load(lock: ModuleLock): Promise<void> {
    try {
      const root = this.moduleRoot(lock);
      await validateTree(root);
      const manifest = await readModuleManifest(root);
      const imported = await import(`${pathToFileURL(path.resolve(root, manifest.entrypoint)).href}?commit=${lock.commit}`);
      const implementation = (imported.default ?? imported.module) as MultivibeModule;
      if (!implementation || typeof implementation !== "object") throw new Error("Module entrypoint must export a module object");
      this.loaded.set(lock.id, { lock, manifest, implementation, healthy: true });
    } catch (error) {
      this.loaded.set(lock.id, {
        lock,
        manifest: { id: lock.id } as ModuleManifest,
        implementation: {},
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveLocks(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const temporary = `${this.lockPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.locks, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.lockPath);
  }

  list(): ModuleView[] {
    return this.locks.map((lock) => {
      const loaded = this.loaded.get(lock.id);
      return {
        ...structuredClone(lock),
        manifest: loaded?.manifest?.name ? structuredClone(loaded.manifest) : undefined,
        loaded: Boolean(loaded?.healthy),
        healthy: loaded?.healthy ?? !lock.enabled,
        error: loaded?.error,
        removable: lock.source !== "bundled",
      };
    }).sort((a, b) => Number(b.source === "bundled") - Number(a.source === "bundled") || a.id.localeCompare(b.id));
  }

  async install(rawUrl: string): Promise<ModuleView> {
    const origin = normalizePublicGitHubUrl(rawUrl);
    const staging = path.join(this.root, `.staging-${randomUUID()}`);
    try {
      await run("git", ["clone", "--depth", "1", "--filter=blob:none", "--no-recurse-submodules", "--", origin, staging]);
      const commit = await run("git", ["rev-parse", "HEAD"], staging);
      await validateTree(staging);
      const manifest = await readModuleManifest(staging);
      if (normalizePublicGitHubUrl(manifest.repository) !== origin) throw new Error("Manifest repository does not match requested origin");
      if (this.locks.some((entry) => entry.id === manifest.id)) throw new Error(`Module ${manifest.id} is already installed`);
      const destination = path.join(this.checkoutRoot, manifest.id);
      await fs.rename(staging, destination);
      this.locks.push({ id: manifest.id, origin, commit, enabled: false, settings: manifest.defaultSettings ?? {}, source: "external", restartRequired: true });
      await this.saveLocks();
      return this.list().find((entry) => entry.id === manifest.id)!;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<ModuleView> {
    const lock = this.locks.find((entry) => entry.id === id);
    if (!lock) throw new Error("Module not found");
    lock.enabled = enabled;
    await this.saveLocks();
    if (enabled && !lock.restartRequired && !this.loaded.has(id)) await this.load(lock);
    if (!enabled) this.loaded.delete(id);
    return this.list().find((entry) => entry.id === id)!;
  }

  async update(id: string): Promise<ModuleView> {
    const lock = this.locks.find((entry) => entry.id === id);
    if (!lock) throw new Error("Module not found");
    const origin = normalizePublicGitHubUrl(lock.origin);
    const staging = path.join(this.root, `.staging-${randomUUID()}`);
    try {
      await run("git", ["clone", "--depth", "1", "--filter=blob:none", "--no-recurse-submodules", "--", origin, staging]);
      const commit = await run("git", ["rev-parse", "HEAD"], staging);
      await validateTree(staging);
      const manifest = await readModuleManifest(staging);
      if (manifest.id !== id) throw new Error("Updated module id does not match installed module");
      const destination = path.join(this.checkoutRoot, id);
      const previous = `${destination}.previous-${randomUUID()}`;
      try {
        await fs.rename(destination, previous);
      } catch (error: any) {
        if (error?.code !== "ENOENT" || lock.source !== "bundled") throw error;
      }
      try {
        await fs.rename(staging, destination);
        await fs.rm(previous, { recursive: true, force: true });
      } catch (error) {
        await fs.rename(previous, destination).catch(() => undefined);
        throw error;
      }
      lock.commit = commit;
      lock.source = "external";
      lock.restartRequired = true;
      await this.saveLocks();
      return this.list().find((entry) => entry.id === id)!;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async setSettings(id: string, settings: Record<string, unknown>): Promise<ModuleView> {
    const lock = this.locks.find((entry) => entry.id === id);
    if (!lock) throw new Error("Module not found");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Settings must be an object");
    lock.settings = structuredClone(settings);
    const loaded = this.loaded.get(id);
    if (loaded) loaded.lock.settings = lock.settings;
    await this.saveLocks();
    return this.list().find((entry) => entry.id === id)!;
  }

  async remove(id: string): Promise<void> {
    const lock = this.locks.find((entry) => entry.id === id);
    if (!lock) throw new Error("Module not found");
    if (lock.source === "bundled") throw new Error("Bundled modules cannot be removed");
    if (lock.enabled) throw new Error("Disable the module before removing it");
    await fs.rm(this.moduleRoot(lock), { recursive: true, force: true });
    this.locks = this.locks.filter((entry) => entry.id !== id);
    this.loaded.delete(id);
    await this.saveLocks();
  }

  async runHook<T>(hook: ModuleHookName, value: T, context: Omit<ModuleContext, "settings" | "log">): Promise<{ value: T; response?: ModuleResponse }> {
    let current = value;
    const modules = [...this.loaded.values()].filter((entry) => entry.healthy && entry.lock.enabled && entry.manifest.hooks.includes(hook)).sort((a, b) => (a.manifest.priority ?? 100) - (b.manifest.priority ?? 100) || a.manifest.id.localeCompare(b.manifest.id));
    for (const entry of modules) {
      const handler = entry.implementation[hook];
      if (!handler) continue;
      const prefix = `[module:${entry.manifest.id}]`;
      try {
        const timeoutMs = Math.max(10, Math.min(60_000, entry.manifest.timeoutMs ?? 5_000));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          handler(structuredClone(current) as Readonly<T>, { ...context, settings: Object.freeze(structuredClone(entry.lock.settings)), log: { info: (message) => console.info(prefix, message), warn: (message) => console.warn(prefix, message), error: (message) => console.error(prefix, message) } }) as Promise<ModuleHookResult<T>> | ModuleHookResult<T>,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`hook timed out after ${timeoutMs}ms`)), timeoutMs);
            timeout.unref?.();
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        if (result?.action === "replace") current = result.value;
        if (result?.action === "respond") return { value: current, response: result.response };
      } catch (error) {
        entry.healthy = false;
        entry.error = error instanceof Error ? error.message : String(error);
        console.error(prefix, `${hook} failed: ${entry.error}`);
        if ((entry.manifest.failurePolicy ?? "open") === "closed") throw error;
      }
    }
    return { value: current };
  }
}
