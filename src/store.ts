import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, OAuthFlowState, OAuthStateFile, StoreFile } from "./types.js";
import { ACCOUNT_FLUSH_INTERVAL_MS } from "./config.js";

const DEFAULT_FILE: StoreFile = { accounts: [] };
const DEFAULT_OAUTH_FILE: OAuthStateFile = { states: [] };

async function ensureFile(filePath: string, seed: object) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, seed);
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

export class AccountStore {
  private inMemoryAccounts: Account[] = [];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_FILE);
    await this.reloadFromDisk();
  }

  private async reloadFromDisk() {
    const raw = await fs.readFile(this.filePath, "utf8");
    const data = JSON.parse(raw) as StoreFile;
    this.inMemoryAccounts = data.accounts;
    this.dirty = false;
  }

  private scheduleFlush() {
    if (this.dirty && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushIfDirty().catch(() => undefined);
      }, ACCOUNT_FLUSH_INTERVAL_MS);
    }
  }

  async flushIfDirty() {
    if (!this.dirty) return;
    await writeJsonAtomic(this.filePath, { accounts: this.inMemoryAccounts });
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getCachedAccounts(): Account[] {
    return [...this.inMemoryAccounts];
  }

  markAccountModified(accountId: string, account: Account) {
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === accountId);
    if (idx === -1) {
      this.inMemoryAccounts.push(account);
    } else {
      this.inMemoryAccounts[idx] = account;
    }
    this.dirty = true;
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
    this.scheduleFlush();
    return true;
  }

  async listAccounts(): Promise<Account[]> {
    return this.getCachedAccounts();
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
