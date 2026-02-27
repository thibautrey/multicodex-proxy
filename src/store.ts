import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, StoreFile } from "./types.js";

const DEFAULT_FILE: StoreFile = { accounts: [] };

export class AccountStore {
  constructor(private filePath: string) {}

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(DEFAULT_FILE);
    }
  }

  async read(): Promise<StoreFile> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as StoreFile;
  }

  async write(data: StoreFile): Promise<void> {
    const tmp = `${this.filePath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.filePath);
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
