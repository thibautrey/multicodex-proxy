import crypto from "node:crypto";
import type http from "node:http";

export type ProxyApiKey = {
  application: string;
  key: string;
};

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseProxyApiKeys(
  legacyKey: string,
  serializedKeys: string,
): ProxyApiKey[] {
  const entries: ProxyApiKey[] = [];
  if (legacyKey) entries.push({ application: "default", key: legacyKey });
  if (!serializedKeys.trim()) return entries;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedKeys);
  } catch {
    throw new Error(
      'PROXY_API_KEYS must be a JSON object such as {"application":"key"}',
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("PROXY_API_KEYS must be a JSON object");
  }

  for (const [rawApplication, rawKey] of Object.entries(parsed)) {
    const application = rawApplication.trim();
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!application || !key) {
      throw new Error("PROXY_API_KEYS application names and keys must be non-empty strings");
    }
    if (entries.some((entry) => entry.application === application)) {
      throw new Error(`Duplicate proxy API key application: ${application}`);
    }
    if (entries.some((entry) => safeEqual(entry.key, key))) {
      throw new Error(`Proxy API keys must be unique (duplicate for ${application})`);
    }
    entries.push({ application, key });
  }
  return entries;
}

export function proxyApiKeyFromHeaders(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  const direct = headers["x-api-key"];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  const authorization = headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function identifyProxyApplication(
  headers: http.IncomingHttpHeaders,
  keys: ProxyApiKey[],
): string | undefined {
  const token = proxyApiKeyFromHeaders(headers);
  if (!token) return undefined;
  return keys.find((entry) => safeEqual(token, entry.key))?.application;
}
