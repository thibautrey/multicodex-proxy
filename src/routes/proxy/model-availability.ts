import type { ProviderId } from "../../types.js";

export type ProviderModelAvailability = {
  activeAccountIds: Set<string>;
  successfulAccountIds: Set<string>;
  modelAccountIds: Map<string, Set<string>>;
  complete: boolean;
};

export type ModelAvailabilityByProvider = Map<
  ProviderId,
  ProviderModelAvailability
>;

export function createProviderModelAvailability(): ProviderModelAvailability {
  return {
    activeAccountIds: new Set(),
    successfulAccountIds: new Set(),
    modelAccountIds: new Map(),
    complete: false,
  };
}

export function recordDiscoveredModel(
  availability: ProviderModelAvailability,
  modelKey: string,
  accountId: string,
): void {
  if (!modelKey) return;
  const accountIds =
    availability.modelAccountIds.get(modelKey) ?? new Set<string>();
  accountIds.add(accountId);
  availability.modelAccountIds.set(modelKey, accountIds);
}

export function finalizeProviderModelAvailability(
  availability: ProviderModelAvailability,
): void {
  availability.complete =
    availability.activeAccountIds.size > 0 &&
    availability.activeAccountIds.size ===
      availability.successfulAccountIds.size;
}

export function accountSupportsModelByAvailability(
  accountId: string,
  provider: ProviderId,
  modelKey: string,
  availabilityByProvider: ReadonlyMap<
    ProviderId,
    ProviderModelAvailability
  >,
): boolean {
  if (!modelKey) return true;

  const availability = availabilityByProvider.get(provider);
  // Without a provider snapshot, or while its catalog is partial, absence is
  // unknown and must not exclude an otherwise enabled account.
  if (
    !availability ||
    !availability.activeAccountIds.size ||
    !availability.complete
  ) {
    return true;
  }

  const accountIds = availability.modelAccountIds.get(modelKey);
  // Keep the existing permissive fallback for models with no discovery
  // metadata (for example a configured proxy model).
  if (!accountIds?.size) return true;
  return accountIds.has(accountId);
}
