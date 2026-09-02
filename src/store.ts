import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Account,
  ApplicationPolicy,
  ModelAlias,
  OAuthFlowState,
  OAuthStateFile,
  StoredProxyApiKey,
  StoreSettings,
  StoreFile,
} from "./types.js";
import { ACCOUNT_FLUSH_INTERVAL_MS } from "./config.js";
import { inferAccountLocation, migrateModelAlias } from "./smart-routing.js";

const DEFAULT_FILE: StoreFile = {
  accounts: [],
  modelAliases: [],
  proxyApiKeys: [],
  applicationPolicies: [],
  settings: {},
};
const DEFAULT_OAUTH_FILE: OAuthStateFile = { states: [] };

type AccountCatalogSnapshot = Omit<Account, "usage" | "state">;

function accountCatalogSnapshot(account: Account): AccountCatalogSnapshot {
  const { usage: _usage, state: _state, ...catalogConfiguration } = account;
  return structuredClone(catalogConfiguration);
}

async function ensureFile(filePath: string, seed: object) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, seed);
  }
  await fs.chmod(filePath, 0o600);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function cleanupOrphanedTmpFiles(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const entries = await fs.readdir(dataDir);
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".tmp-"))
      .map((f) => fs.unlink(path.join(dataDir, f)))
  );
}

export class AccountStore {
  private inMemoryAccounts: Account[] = [];
  private inMemoryModelAliases: ModelAlias[] = [];
  private inMemoryProxyApiKeys: StoredProxyApiKey[] = [];
  private inMemoryApplicationPolicies: ApplicationPolicy[] = [];
  private inMemorySettings: StoreSettings = {};
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  // Persistence writes use their own generation so a mutation that arrives
  // during a flush cannot be lost.
  private revision = 0;
  // Model discovery only depends on account configuration and aliases. Runtime
  // telemetry (usage, selection timestamps, blocks, and errors) must not make
  // an otherwise fresh catalog stale.
  private catalogRevision = 0;
  private accountCatalogSnapshots = new Map<string, AccountCatalogSnapshot>();
  private modelAliasCatalogSnapshots = new Map<string, ModelAlias>();
  private lastFlushError: { at: number; message: string } | undefined;

  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_FILE);
    await this.reloadFromDisk();
  }

  private async reloadFromDisk() {
    const raw = await fs.readFile(this.filePath, "utf8");
    const data = JSON.parse(raw) as StoreFile & { modelAliases?: unknown[] };
    let migrated = false;
    this.inMemoryAccounts = Array.isArray(data.accounts)
      ? data.accounts.map((account) => {
          if (account.location) return account;
          migrated = true;
          return { ...account, location: inferAccountLocation(account) };
        })
      : [];
    this.inMemoryModelAliases = Array.isArray(data.modelAliases)
      ? data.modelAliases.map((alias) => {
          const next = migrateModelAlias(alias);
          if ((alias as any)?.schemaVersion !== 2) migrated = true;
          return next;
        })
      : [];
    this.inMemoryProxyApiKeys = Array.isArray(data.proxyApiKeys)
      ? data.proxyApiKeys
      : [];
    this.inMemoryApplicationPolicies = Array.isArray(data.applicationPolicies)
      ? data.applicationPolicies.map((policy) => ({
          application: policy.application,
          fairnessWeight: Math.max(0.1, Number(policy.fairnessWeight) || 1),
          webhooks: Array.isArray(policy.webhooks)
            ? policy.webhooks.map((webhook) => ({ ...webhook }))
            : [],
        }))
      : [];
    this.inMemorySettings =
      data.settings && typeof data.settings === "object"
        ? { ...data.settings }
        : {};
    this.accountCatalogSnapshots = new Map(
      this.inMemoryAccounts.map((account) => [
        account.id,
        accountCatalogSnapshot(account),
      ]),
    );
    this.modelAliasCatalogSnapshots = new Map(
      this.inMemoryModelAliases.map((alias) => [
        alias.id,
        structuredClone(alias),
      ]),
    );
    this.dirty = migrated;
    if (migrated) {
      this.revision += 1;
      await this.flushIfDirty();
    }
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
            proxyApiKeys: this.inMemoryProxyApiKeys,
            applicationPolicies: this.inMemoryApplicationPolicies,
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

  getRevision(): number {
    return this.revision;
  }

  getCatalogRevision(): number {
    return this.catalogRevision;
  }

  getCachedAccounts(): Account[] {
    return [...this.inMemoryAccounts];
  }

  getCachedModelAliases(): ModelAlias[] {
    return this.inMemoryModelAliases.map((alias) => structuredClone(alias));
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
    const normalized = account.location
      ? account
      : { ...account, location: inferAccountLocation(account) };
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === accountId);
    const previousCatalogSnapshot = this.accountCatalogSnapshots.get(accountId);
    const nextCatalogSnapshot = accountCatalogSnapshot(normalized);
    const catalogChanged =
      idx === -1 ||
      accountId !== normalized.id ||
      !previousCatalogSnapshot ||
      !isDeepStrictEqual(previousCatalogSnapshot, nextCatalogSnapshot);
    if (idx === -1) {
      this.inMemoryAccounts.push(normalized);
    } else {
      this.inMemoryAccounts[idx] = normalized;
    }
    if (accountId !== normalized.id) {
      this.accountCatalogSnapshots.delete(accountId);
    }
    this.accountCatalogSnapshots.set(normalized.id, nextCatalogSnapshot);
    this.dirty = true;
    this.revision += 1;
    if (catalogChanged) this.catalogRevision += 1;
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
    this.accountCatalogSnapshots.delete(id);
    this.dirty = true;
    this.revision += 1;
    this.catalogRevision += 1;
    await this.flushIfDirty();
    return true;
  }

  async listAccounts(): Promise<Account[]> {
    return this.getCachedAccounts();
  }

  private markModelAliasModified(aliasId: string, alias: ModelAlias) {
    const idx = this.inMemoryModelAliases.findIndex((a) => a.id === aliasId);
    const previousCatalogSnapshot =
      this.modelAliasCatalogSnapshots.get(aliasId);
    const nextCatalogSnapshot = structuredClone(alias);
    const catalogChanged =
      idx === -1 ||
      aliasId !== alias.id ||
      !previousCatalogSnapshot ||
      !isDeepStrictEqual(previousCatalogSnapshot, nextCatalogSnapshot);
    if (idx === -1) {
      this.inMemoryModelAliases.push(alias);
    } else {
      this.inMemoryModelAliases[idx] = alias;
    }
    if (aliasId !== alias.id) {
      this.modelAliasCatalogSnapshots.delete(aliasId);
    }
    this.modelAliasCatalogSnapshots.set(alias.id, nextCatalogSnapshot);
    this.dirty = true;
    this.revision += 1;
    if (catalogChanged) this.catalogRevision += 1;
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
      schemaVersion: 2,
      rules: Array.isArray(patch.rules)
        ? structuredClone(patch.rules)
        : structuredClone(existing.rules),
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
    this.modelAliasCatalogSnapshots.delete(id);
    this.dirty = true;
    this.revision += 1;
    this.catalogRevision += 1;
    await this.flushIfDirty();
    return true;
  }

  getCachedProxyApiKeys(): StoredProxyApiKey[] {
    return this.inMemoryProxyApiKeys.map((entry) => ({ ...entry }));
  }

  async listProxyApiKeys(): Promise<StoredProxyApiKey[]> {
    return this.getCachedProxyApiKeys();
  }

  async addProxyApiKey(entry: StoredProxyApiKey): Promise<StoredProxyApiKey> {
    this.inMemoryProxyApiKeys.push({ ...entry });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return { ...entry };
  }

  async deleteProxyApiKey(id: string): Promise<boolean> {
    const before = this.inMemoryProxyApiKeys.length;
    this.inMemoryProxyApiKeys = this.inMemoryProxyApiKeys.filter(
      (entry) => entry.id !== id,
    );
    if (this.inMemoryProxyApiKeys.length === before) return false;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }

  getCachedApplicationPolicies(): ApplicationPolicy[] {
    return this.inMemoryApplicationPolicies.map((policy) => structuredClone(policy));
  }

  getApplicationPolicy(application: string): ApplicationPolicy {
    const policy = this.inMemoryApplicationPolicies.find(
      (entry) => entry.application === application,
    );
    return policy
      ? structuredClone(policy)
      : { application, fairnessWeight: 1, webhooks: [] };
  }

  async upsertApplicationPolicy(policy: ApplicationPolicy): Promise<ApplicationPolicy> {
    const normalized: ApplicationPolicy = {
      application: policy.application,
      fairnessWeight: Math.max(0.1, Math.min(100, Number(policy.fairnessWeight) || 1)),
      webhooks: policy.webhooks.map((webhook) => ({ ...webhook })),
    };
    const index = this.inMemoryApplicationPolicies.findIndex(
      (entry) => entry.application === normalized.application,
    );
    if (index === -1) this.inMemoryApplicationPolicies.push(normalized);
    else this.inMemoryApplicationPolicies[index] = normalized;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(normalized);
  }
}

export class OAuthStateStore {
  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_OAUTH_FILE);
  }

  private async read(): Promise<OAuthStateFile> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as OAuthStateFile;
  }

  private async write(data: OAuthStateFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data);
  }

  async create(state: OAuthFlowState) {
    const data = await this.read();
    data.states = [state, ...data.states.filter((s) => s.id !== state.id)].slice(0, 200);
    await this.write(data);
  }

  async get(id: string): Promise<OAuthFlowState | undefined> {
    const data = await this.read();
    return data.states.find((s) => s.id === id);
  }

  async update(id: string, patch: Partial<OAuthFlowState>): Promise<OAuthFlowState | undefined> {
    const data = await this.read();
    const idx = data.states.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    data.states[idx] = { ...data.states[idx], ...patch };
    await this.write(data);
    return data.states[idx];
  }
}
