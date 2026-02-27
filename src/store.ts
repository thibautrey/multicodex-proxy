import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, OAuthFlowState, OAuthStateFile, StoreFile } from "./types.js";

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
  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_FILE);
  }

  async read(): Promise<StoreFile> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as StoreFile;
  }

  async write(data: StoreFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data);
  }

  async listAccounts(): Promise<Account[]> {
    const data = await this.read();
    return data.accounts;
  }

  async upsertAccount(account: Account): Promise<Account> {
    const data = await this.read();
    const idx = data.accounts.findIndex((a) => a.id === account.id);
    if (idx === -1) data.accounts.push(account);
    else data.accounts[idx] = account;
    await this.write(data);
    return account;
  }

  async patchAccount(id: string, patch: Partial<Account>): Promise<Account | null> {
    const data = await this.read();
    const idx = data.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    data.accounts[idx] = {
      ...data.accounts[idx],
      ...patch,
      state: { ...data.accounts[idx].state, ...patch.state },
      usage: patch.usage ?? data.accounts[idx].usage,
    };
    await this.write(data);
    return data.accounts[idx];
  }

  async deleteAccount(id: string): Promise<boolean> {
    const data = await this.read();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== id);
    if (data.accounts.length === before) return false;
    await this.write(data);
    return true;
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
