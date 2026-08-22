export type TraceHeaderValue = string | string[] | undefined;
export type TraceHeaderMap = Record<string, TraceHeaderValue>;

export const TRACE_HEADERS_FORWARD_HEADER =
  "x-multivibe-trace-request-headers";

const MAX_HEADER_VALUE_LENGTH = 512;
const REDACTED_HEADER_VALUE = "[REDACTED]";

const SENSITIVE_HEADER_PATTERN =
  /(?:^|[-_])(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|credential|cookie|set[-_]?cookie|session(?:[-_]?id)?|state|nonce|signature|hmac)(?:$|[-_])/i;

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name);
}

function truncateHeaderValue(value: string): string {
  if (value.length <= MAX_HEADER_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_HEADER_VALUE_LENGTH)}...[truncated]`;
}

function valuesToString(value: TraceHeaderValue): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(", ");
  }
  return undefined;
}

export function sanitizeRequestHeaders(
  headers: TraceHeaderMap,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === TRACE_HEADERS_FORWARD_HEADER) continue;
    const value = valuesToString(rawValue);
    if (typeof value === "undefined") continue;
    sanitized[name] = isSensitiveHeader(name)
      ? REDACTED_HEADER_VALUE
      : truncateHeaderValue(value);
  }
  return Object.fromEntries(
    Object.entries(sanitized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizeTraceHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate: TraceHeaderMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" || Array.isArray(value)) {
      candidate[name] = value as string | string[];
    }
  }
  const normalized = sanitizeRequestHeaders(candidate);
  return Object.keys(normalized).length ? normalized : undefined;
}

export function traceHeadersForRequest(
  headers: TraceHeaderMap,
): Record<string, string> {
  const forwarded = headers[TRACE_HEADERS_FORWARD_HEADER];
  if (typeof forwarded === "string") {
    try {
      const parsed = normalizeTraceHeaders(JSON.parse(forwarded));
      if (parsed) return parsed;
    } catch {
      // Fall back to the headers on the current request.
    }
  }
  return sanitizeRequestHeaders(headers);
}

export function serializeTraceHeaders(headers: TraceHeaderMap): string {
  return JSON.stringify(sanitizeRequestHeaders(headers));
}
