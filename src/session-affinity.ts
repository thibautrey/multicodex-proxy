import type { Account, ProviderId } from "./types.js";
import { CODEX_SESSION_AFFINITY_MAX_ENTRIES } from "./config.js";

export const SESSION_AFFINITY_TTL_MS = 60 * 60_000;

type SessionAffinityEntry = {
  accountId: string;
  expiresAt: number;
};

function affinityKey(
  application: string,
  sessionId: string,
  provider: ProviderId,
): string {
  return JSON.stringify([application, sessionId, provider]);
}

export class SessionAffinityCache {
  private readonly entries = new Map<string, SessionAffinityEntry>();
  private readonly maxEntries: number;

  constructor(
    private readonly ttlMs: number = SESSION_AFFINITY_TTL_MS,
    maxEntries: number = CODEX_SESSION_AFFINITY_MAX_ENTRIES,
  ) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(1, Math.floor(maxEntries))
      : CODEX_SESSION_AFFINITY_MAX_ENTRIES;
  }

  get(
    application: string,
    sessionId: string,
    provider: ProviderId,
    now = Date.now(),
  ): string | undefined {
    const key = affinityKey(application, sessionId, provider);
    const accountId = this.peek(application, sessionId, provider, now);
    if (!accountId) return undefined;

    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Reads also refresh recency so an actively used session is not evicted
    // before an idle session merely because it was inserted earlier.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return accountId;
  }

  peek(
    application: string,
    sessionId: string,
    provider: ProviderId,
    now = Date.now(),
  ): string | undefined {
    const key = affinityKey(application, sessionId, provider);
    const entry = this.entries.get(key);

    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.accountId;
  }

  remember(
    application: string,
    sessionId: string,
    provider: ProviderId,
    accountId: string,
    now = Date.now(),
  ) {
    this.pruneExpired(now);

    const key = affinityKey(application, sessionId, provider);
    // Move refreshed entries to the back so eviction is least-recently-used.
    this.entries.delete(key);
    this.entries.set(key, {
      accountId,
      expiresAt: now + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.entries.delete(oldestKey);
    }
  }

  forget(application: string, sessionId: string, provider: ProviderId) {
    this.entries.delete(affinityKey(application, sessionId, provider));
  }

  private pruneExpired(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export function findSessionAffinityAccount(
  cache: SessionAffinityCache,
  enabled: boolean,
  application: string,
  sessionId: string | undefined,
  provider: ProviderId,
  eligibleAccounts: Account[],
  now = Date.now(),
): Account | undefined {
  if (!enabled || !sessionId) return undefined;

  const accountId = cache.get(application, sessionId, provider, now);
  if (!accountId) return undefined;

  const account = eligibleAccounts.find(
    (candidate) => candidate.id === accountId,
  );

  if (!account) {
    // The sticky account became ineligible (quota, model block, auth block,
    // routing policy, or retry exclusion). Drop the stale mapping so normal
    // routing can select a replacement.
    cache.forget(application, sessionId, provider);
  }

  return account;
}

export function preferSessionAffinityAccount(
  affinityAccount: Account | undefined,
  preferredAccount: Account | undefined,
): Account | undefined {
  return affinityAccount ?? preferredAccount;
}
