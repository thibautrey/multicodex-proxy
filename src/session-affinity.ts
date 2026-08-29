import type { Account, ProviderId } from "./types.js";

export const SESSION_AFFINITY_TTL_MS = 60 * 60_000;

type SessionAffinityEntry = {
  accountId: string;
  expiresAt: number;
};

function affinityKey(sessionId: string, provider: ProviderId): string {
  return `${sessionId}\0${provider}`;
}

export class SessionAffinityCache {
  private readonly entries = new Map<string, SessionAffinityEntry>();

  constructor(
    private readonly ttlMs: number = SESSION_AFFINITY_TTL_MS,
  ) {}

  get(
    sessionId: string,
    provider: ProviderId,
    now = Date.now(),
  ): string | undefined {
    const key = affinityKey(sessionId, provider);
    const entry = this.entries.get(key);

    if (!entry) return undefined;

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.accountId;
  }

  remember(
    sessionId: string,
    provider: ProviderId,
    accountId: string,
    now = Date.now(),
  ) {
    this.pruneExpired(now);

    this.entries.set(affinityKey(sessionId, provider), {
      accountId,
      expiresAt: now + this.ttlMs,
    });
  }

  forget(sessionId: string, provider: ProviderId) {
    this.entries.delete(affinityKey(sessionId, provider));
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
  sessionId: string | undefined,
  provider: ProviderId,
  eligibleAccounts: Account[],
  now = Date.now(),
): Account | undefined {
  if (!enabled || !sessionId) return undefined;

  const accountId = cache.get(sessionId, provider, now);
  if (!accountId) return undefined;

  const account = eligibleAccounts.find(
    (candidate) => candidate.id === accountId,
  );

  if (!account) {
    // The sticky account became ineligible (quota, model block, auth block,
    // routing policy, or retry exclusion). Drop the stale mapping so normal
    // routing can select a replacement.
    cache.forget(sessionId, provider);
  }

  return account;
}

export function preferSessionAffinityAccount(
  affinityAccount: Account | undefined,
  preferredAccount: Account | undefined,
): Account | undefined {
  return affinityAccount ?? preferredAccount;
}
