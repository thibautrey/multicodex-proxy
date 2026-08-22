import { isUsageRefreshNeeded, refreshUsageIfNeeded } from "./quota.js";
import type { Account } from "./types.js";

export type UsageRefreshMode = "fresh" | "blocking" | "background";

export type UsageRefreshPreparation = {
  account: Account;
  mode: UsageRefreshMode;
  shared: boolean;
};

type RefreshUsage = (
  account: Account,
  baseUrl: string,
  force?: boolean,
) => Promise<Account>;

type PrepareOptions = {
  staleWhileRevalidate: boolean;
  maxStaleAgeMs?: number;
  /**
   * A missing usage snapshot is still enough to route a request. When this
   * flag is enabled, let routing use the account's local zero-usage fallback
   * while the first probe runs in the background.
   */
  serveMissingSnapshotWhileRevalidating?: boolean;
  onBackgroundUpdate?: (account: Account) => void | Promise<void>;
};

type InFlightRefresh = {
  promise: Promise<Account>;
};

export class UsageRefreshCoordinator {
  private readonly inFlight = new Map<string, InFlightRefresh>();

  constructor(
    private readonly refreshUsage: RefreshUsage = refreshUsageIfNeeded,
  ) {}

  async prepare(
    account: Account,
    baseUrl: string,
    options: PrepareOptions,
  ): Promise<UsageRefreshPreparation> {
    if (!isUsageRefreshNeeded(account)) {
      return { account, mode: "fresh", shared: false };
    }

    const key = `${account.id}\u0000${baseUrl}`;
    let active = this.inFlight.get(key);
    const shared = Boolean(active);
    if (!active) {
      const snapshot = structuredClone(account);
      const promise = this.refreshUsage(snapshot, baseUrl).finally(() => {
        if (this.inFlight.get(key)?.promise === promise) {
          this.inFlight.delete(key);
        }
      });
      active = { promise };
      this.inFlight.set(key, active);
    }

    const staleAgeMs = account.usage
      ? Math.max(0, Date.now() - account.usage.fetchedAt)
      : Infinity;
    const withinStaleLimit =
      staleAgeMs <= (options.maxStaleAgeMs ?? Infinity);
    const canServeMissingSnapshot =
      !account.usage &&
      options.serveMissingSnapshotWhileRevalidating === true;
    if (
      options.staleWhileRevalidate &&
      ((account.usage && withinStaleLimit) || canServeMissingSnapshot)
    ) {
      if (!shared && options.onBackgroundUpdate) {
        void active.promise
          .then(async (updated) => {
            if (
              updated.usage &&
              updated.usage.fetchedAt > account.usage!.fetchedAt
            ) {
              await options.onBackgroundUpdate!(updated);
            }
          })
          .catch(() => undefined);
      }
      return { account, mode: "background", shared };
    }

    return {
      account: await active.promise,
      mode: "blocking",
      shared,
    };
  }
}
