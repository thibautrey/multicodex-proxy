import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Account,
  ModelAlias,
  OAuthFlowState,
  OAuthStateFile,
  StoreSettings,
  StoreFile,
} from "./types.js";
import { ACCOUNT_FLUSH_INTERVAL_MS } from "./config.js";

const DEFAULT_FILE: StoreFile = { accounts: [], modelAliases: [], settings: {} };
const DEFAULT_OAUTH_FILE: OAuthStateFile = { states: [] };

async function ensureFile(filePath: string, seed: object) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, seed);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(filePath: string): Promise<void> {
  const handle = await fs.open(path.dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  createBackup = true,
): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (createBackup) {
      await fs.copyFile(filePath, `${filePath}.bak`);
      await syncFile(`${filePath}.bak`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.rename(tmp, filePath);
  await syncDirectory(filePath);
}

async function readJsonWithBackup<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (primaryError) {
    try {
      const recovered = JSON.parse(
        await fs.readFile(`${filePath}.bak`, "utf8"),
      ) as T;
      await writeJsonAtomic(filePath, recovered, false);
      console.error(
        `recovered ${filePath} from backup: ${
          primaryError instanceof Error ? primaryError.message : String(primaryError)
        }`,
      );
      return recovered;
    } catch {
      throw primaryError;
    }
  }
}

export async function cleanupOrphanedTmpFiles(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const entries = await fs.readdir(dataDir);
  await Promise.all(
    entries
      .filter((f) => /\.tmp-[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(f))
      .map((f) => fs.unlink(path.join(dataDir, f)).catch(() => undefined))
  );
}

export class AccountStore {
  private inMemoryAccounts: Account[] = [];
  private inMemoryModelAliases: ModelAlias[] = [];
  private inMemorySettings: StoreSettings = {};
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private revision = 0;
  private lastFlushError: { at: number; message: string } | undefined;

  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_FILE);
    await this.reloadFromDisk();
  }

  private async reloadFromDisk() {
    const data = await readJsonWithBackup<StoreFile>(this.filePath);
    this.inMemoryAccounts = Array.isArray(data.accounts) ? data.accounts : [];
    this.inMemoryModelAliases = Array.isArray(data.modelAliases)
      ? data.modelAliases
      : [];
    this.inMemorySettings =
      data.settings && typeof data.settings === "object"
        ? { ...data.settings }
        : {};
    this.dirty = false;
  }

  private scheduleFlush() {
    if (this.dirty && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushIfDirty().catch((error) => {
          console.error("account store flush failed", error);
        });
      }, ACCOUNT_FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  async flushIfDirty() {
    if (this.flushPromise) return this.flushPromise;
    if (!this.dirty) return;

    this.flushPromise = (async () => {
      while (this.dirty) {
        const revision = this.revision;
        try {
          await writeJsonAtomic(this.filePath, {
            accounts: this.inMemoryAccounts,
            modelAliases: this.inMemoryModelAliases,
            settings: this.inMemorySettings,
          });
          this.lastFlushError = undefined;
          if (this.revision === revision) this.dirty = false;
        } catch (error: any) {
          this.lastFlushError = {
            at: Date.now(),
            message: error?.message ?? String(error),
          };
          throw error;
        }
      }
    })().finally(() => {
      this.flushPromise = null;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (this.dirty) this.scheduleFlush();
    });

    return this.flushPromise;
  }

  getPersistenceStatus() {
    return {
      dirty: this.dirty,
      flushPending: Boolean(this.flushPromise || this.flushTimer),
      lastError: this.lastFlushError,
    };
  }

  getCachedAccounts(): Account[] {
    return [...this.inMemoryAccounts];
  }

  getCachedModelAliases(): ModelAlias[] {
    return this.inMemoryModelAliases.map((a) => ({ ...a, targets: [...a.targets] }));
  }

  getCachedSettings(): StoreSettings {
    return { ...this.inMemorySettings };
  }

  async getSettings(): Promise<StoreSettings> {
    return this.getCachedSettings();
  }

  async patchSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
    this.inMemorySettings = {
      ...this.inMemorySettings,
      ...patch,
    };
    if (!this.inMemorySettings.defaultPassthroughAccountId) {
      delete this.inMemorySettings.defaultPassthroughAccountId;
    }
    if (!this.inMemorySettings.imageRequestModelOverride) {
      delete this.inMemorySettings.imageRequestModelOverride;
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
    await this.flushIfDirty();
    return this.getCachedSettings();
  }

  markAccountModified(accountId: string, account: Account) {
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === accountId);
    if (idx === -1) {
      this.inMemoryAccounts.push(account);
    } else {
      this.inMemoryAccounts[idx] = account;
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
  }

  async addOrUpdate(account: Account) {
    this.markAccountModified(account.id, account);
    await this.flushIfDirty();
    return account;
  }

  async upsertAccount(account: Account): Promise<Account> {
    this.markAccountModified(account.id, account);
    return account;
  }

  async patchAccount(id: string, patch: Partial<Account>): Promise<Account | null> {
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const existing = this.inMemoryAccounts[idx];
    const updated = {
      ...existing,
      ...patch,
      state: { ...existing.state, ...patch.state },
      usage: patch.usage ?? existing.usage,
    };
    this.markAccountModified(id, updated);
    return updated;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const before = this.inMemoryAccounts.length;
    this.inMemoryAccounts = this.inMemoryAccounts.filter((a) => a.id !== id);
    if (this.inMemoryAccounts.length === before) return false;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }

  async listAccounts(): Promise<Account[]> {
    return this.getCachedAccounts();
  }

  private markModelAliasModified(aliasId: string, alias: ModelAlias) {
    const idx = this.inMemoryModelAliases.findIndex((a) => a.id === aliasId);
    if (idx === -1) {
      this.inMemoryModelAliases.push(alias);
    } else {
      this.inMemoryModelAliases[idx] = alias;
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
  }

  async listModelAliases(): Promise<ModelAlias[]> {
    return this.getCachedModelAliases();
  }

  async upsertModelAlias(alias: ModelAlias): Promise<ModelAlias> {
    this.markModelAliasModified(alias.id, alias);
    return alias;
  }

  async patchModelAlias(
    id: string,
    patch: Partial<ModelAlias>,
  ): Promise<ModelAlias | null> {
    const idx = this.inMemoryModelAliases.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const existing = this.inMemoryModelAliases[idx];
    const updated: ModelAlias = {
      ...existing,
      ...patch,
      id: existing.id,
      targets: Array.isArray(patch.targets)
        ? [...patch.targets]
        : [...existing.targets],
    };
    this.markModelAliasModified(id, updated);
    return updated;
  }

  async deleteModelAlias(id: string): Promise<boolean> {
    const before = this.inMemoryModelAliases.length;
    this.inMemoryModelAliases = this.inMemoryModelAliases.filter(
      (a) => a.id !== id,
    );
    if (this.inMemoryModelAliases.length === before) return false;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }
}

export class OAuthStateStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_OAUTH_FILE);
  }

  private async read(): Promise<OAuthStateFile> {
    return readJsonWithBackup<OAuthStateFile>(this.filePath);
  }

  private async write(data: OAuthStateFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data);
  }

  async create(state: OAuthFlowState) {
    const run = this.mutationQueue.then(async () => {
      const data = await this.read();
      data.states = [state, ...data.states.filter((s) => s.id !== state.id)].slice(0, 200);
      await this.write(data);
    });
    this.mutationQueue = run.catch(() => undefined);
    await run;
  }

  async get(id: string): Promise<OAuthFlowState | undefined> {
    const data = await this.read();
    return data.states.find((s) => s.id === id);
  }

  async update(id: string, patch: Partial<OAuthFlowState>): Promise<OAuthFlowState | undefined> {
    let updated: OAuthFlowState | undefined;
    const run = this.mutationQueue.then(async () => {
      const data = await this.read();
      const idx = data.states.findIndex((s) => s.id === id);
      if (idx === -1) return;
      data.states[idx] = { ...data.states[idx], ...patch };
      updated = data.states[idx];
      await this.write(data);
    });
    this.mutationQueue = run.catch(() => undefined);
    await run;
    return updated;
  }
}
