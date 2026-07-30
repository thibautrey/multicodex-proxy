type SerializerRuntime = {
  stringify?: typeof JSON.stringify;
  minCacheCharacters?: number;
};

const DEFAULT_MIN_CACHE_CHARACTERS = 64 * 1024;

/**
 * Reuses a serialized payload only within one proxy request. The large
 * Responses input is keyed by object identity, while every other top-level
 * field is serialized into the variant key so routing or account-specific
 * payload changes always miss the cache.
 */
export function createUpstreamPayloadSerializer(
  runtime: SerializerRuntime = {},
): (payload: any) => string {
  const stringify = runtime.stringify ?? JSON.stringify;
  const minCacheCharacters =
    runtime.minCacheCharacters ?? DEFAULT_MIN_CACHE_CHARACTERS;
  const byInput = new WeakMap<object, Map<string, string>>();

  return (payload: any): string => {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) {
      return stringify(payload) as string;
    }

    const input = payload.input as object;
    const cachedVariants = byInput.get(input);
    if (cachedVariants) {
      const { input: _input, ...variant } = payload;
      const variantKey = stringify(variant) as string;
      const cached = cachedVariants.get(variantKey);
      if (cached !== undefined) return cached;

      const serialized = stringify(payload) as string;
      if (serialized.length >= minCacheCharacters) {
        cachedVariants.set(variantKey, serialized);
      }
      return serialized;
    }

    const serialized = stringify(payload) as string;
    if (serialized.length >= minCacheCharacters) {
      const { input: _input, ...variant } = payload;
      const variantKey = stringify(variant) as string;
      byInput.set(input, new Map([[variantKey, serialized]]));
    }
    return serialized;
  };
}
