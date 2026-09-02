import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

export type ProviderAgentSelection = {
  schema_version: "provider-selection-v1";
  revision: number;
  state: "detected" | "selected";
  selected_models: string[];
};

export type ProviderAgentManifest = {
  protocol_version: "provider-agent-v1";
  state: "detected" | "selected" | "submitted";
  selected_models: string[];
  device_key_id?: string;
  device_public_key_spki?: string;
};

export type ProviderRelayShadowSessionRequest = {
  session_id: string;
  organization_id: string;
  provider_id: string;
  node_id: string;
  credential_epoch: number;
  relay_id: string;
  region: string;
  transport: "outbound_mtls" | "tailscale_private";
};

export type SignedProviderRelayShadowSession = {
  envelopeVersion: "multivibe-provider-relay-envelope-v1";
  kind: "relay_session_open";
  payload: Record<string, unknown> & {
    shadowOnly: true;
    customerTrafficAllowed: false;
    routingEligible: false;
    compensationEligible: false;
  };
  signature: { algorithm: "Ed25519"; keyId: string; value: string };
};

export type ProviderCloudEnrollmentRequest = {
  enrollment_token: string;
  core_version: string;
  runtime_family: "lm-studio" | "omlx" | "exo" | "mtplx";
  selected_models: Array<{ reported_id: string; modalities: string[] }>;
  declared_max_concurrency: number;
};

export type ProviderCloudEnrollmentView = {
  schema_version: "provider-cloud-enrollment-v1";
  revision: 1;
  state: "submitted";
  provider_id: string;
  node_id: string;
  device_key_id: string;
  credential_epoch: number;
  manifest_digest: string;
  runtime_family: "lm-studio" | "omlx" | "exo" | "mtplx";
  declared_max_concurrency: number;
  cloud_api_origin: string;
  submitted_at: string;
  routing_eligible: false;
  compensation_eligible: false;
  safety_profile: "shadow_only_no_routing_no_compensation";
};

export type ProviderAgentDetectedModels = {
  schema_version: "provider-detected-models-v1";
  runtimes: Array<{ adapter_id: string; models: string[] }>;
};

export type ProviderAgentRuntimeEndpointInput = {
  adapter_id: string;
  endpoint: string;
  bearer_token?: string;
};

export type ProviderAgentRuntimeEndpoints = {
  schema_version: "provider-runtime-endpoints-v1";
  revision: number;
  endpoints: Array<{
    adapter_id: string;
    endpoint: string;
    authentication: "none" | "bearer";
  }>;
};

export type ProviderAgentAdapterRegistry = {
  schema_version: "provider-runtime-registry-v2";
  adapters: Array<{
    id: string;
    display_name: string;
    protocol: "openai-compatible" | "native";
    authentication: "none" | "optional-bearer" | "required-bearer";
    automatic_loopback_candidates: Array<{ endpoint: string }>;
  }>;
};

export type ProviderAgentControl = {
  enabled: boolean;
  getManifest(): Promise<ProviderAgentManifest>;
  getSelection(): Promise<ProviderAgentSelection>;
  replaceSelection(revision: number, selectedModels: string[]): Promise<{ conflict: boolean; selection: ProviderAgentSelection }>;
  getAdapters(): Promise<ProviderAgentAdapterRegistry>;
  getRuntimeEndpoints(): Promise<ProviderAgentRuntimeEndpoints>;
  replaceRuntimeEndpoints(revision: number, endpoints: ProviderAgentRuntimeEndpointInput[]): Promise<{ conflict: boolean; endpoints: ProviderAgentRuntimeEndpoints }>;
  detectModels(): Promise<ProviderAgentDetectedModels>;
  getCloudEnrollment(): Promise<ProviderCloudEnrollmentView>;
  enrollCloud(request: ProviderCloudEnrollmentRequest): Promise<ProviderCloudEnrollmentView>;
  openRelayShadowSession(request: ProviderRelayShadowSessionRequest): Promise<SignedProviderRelayShadowSession>;
};

export type ProviderAgentSupervisor = ProviderAgentControl & { stop(): Promise<void> };

export class ProviderAgentControlRequestError extends Error {
  constructor(readonly status: number) {
    super("provider agent control request was rejected");
  }
}

const PROVIDER_AGENT_ENVIRONMENT_KEYS = [
  "MULTIVIBE_CORE_LOOPBACK_URL",
  "MULTIVIBE_PROVIDER_AGENT_LISTEN",
  "MULTIVIBE_PROVIDER_SELECTED_MODELS",
] as const;

export function providerAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PROVIDER_AGENT_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function providerAgentChildEnvironment(
  source: NodeJS.ProcessEnv,
  statePath: string | undefined,
  controlToken: string,
  runtimeStatePath?: string,
  deviceKeyPath?: string,
  enrollmentStatePath?: string,
  cloudApiUrl?: string,
): NodeJS.ProcessEnv {
  return {
    ...providerAgentEnvironment(source),
    ...(statePath ? { MULTIVIBE_PROVIDER_STATE_PATH: statePath } : {}),
    ...(runtimeStatePath ? { MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: runtimeStatePath } : {}),
    ...(deviceKeyPath ? { MULTIVIBE_PROVIDER_DEVICE_KEY_PATH: deviceKeyPath } : {}),
    ...(enrollmentStatePath ? { MULTIVIBE_PROVIDER_ENROLLMENT_STATE_PATH: enrollmentStatePath } : {}),
    ...(cloudApiUrl ? { MULTIVIBE_CLOUD_API_URL: cloudApiUrl } : {}),
    MULTIVIBE_PROVIDER_CONTROL_TOKEN: controlToken,
  };
}

export function isValidProviderSelectedModelId(model: unknown): model is string {
  if (typeof model !== "string" || model.length === 0 || Buffer.byteLength(model) > 200
    || model.trim() !== model || model.includes("\\")
    || /[A-Za-z][A-Za-z0-9+.-]*:\//.test(model) || model.startsWith("/")
    || /^[A-Za-z]:\//.test(model) || /\p{Cc}/u.test(model)) return false;
  return model.split("/").every((segment) => {
    if (segment === "." || segment === ".." || isIP(segment) !== 0) return false;
    if (segment.startsWith("[") && segment.endsWith("]") && isIP(segment.slice(1, -1)) !== 0) return false;
    return true;
  });
}

export function isValidProviderRuntimeEndpointInput(
  value: unknown,
): value is ProviderAgentRuntimeEndpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !["adapter_id", "endpoint", "bearer_token"].includes(key))) return false;
  if (typeof input.adapter_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.adapter_id)) return false;
  if (typeof input.endpoint !== "string" || input.endpoint.length > 256 || input.endpoint.trim() !== input.endpoint) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return false;
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")
    || !endpoint.port || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) return false;
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  if (input.bearer_token !== undefined) {
    if (typeof input.bearer_token !== "string" || Buffer.byteLength(input.bearer_token) > 4096
      || /\p{Cc}/u.test(input.bearer_token)) return false;
  }
  return true;
}

export function isValidProviderRelayShadowSessionRequest(
  value: unknown,
): value is ProviderRelayShadowSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = [
    "session_id", "organization_id", "provider_id", "node_id", "credential_epoch",
    "relay_id", "region", "transport",
  ];
  if (Object.keys(request).length !== keys.length || keys.some((key) => !(key in request))) return false;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  for (const key of ["session_id", "organization_id", "provider_id", "node_id", "relay_id", "region"]) {
    if (typeof request[key] !== "string" || !identifier.test(request[key])) return false;
  }
  if (!Number.isSafeInteger(request.credential_epoch)
    || (request.credential_epoch as number) < 1
    || (request.credential_epoch as number) > 2 ** 48 - 1) return false;
  return request.transport === "outbound_mtls" || request.transport === "tailscale_private";
}

export function isValidProviderCloudEnrollmentRequest(
  value: unknown,
): value is ProviderCloudEnrollmentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = ["enrollment_token", "core_version", "runtime_family", "selected_models", "declared_max_concurrency"];
  if (Object.keys(request).length !== keys.length || keys.some((key) => !(key in request))) return false;
  if (typeof request.enrollment_token !== "string" || !/^mve_[A-Za-z0-9_-]{43}$/.test(request.enrollment_token)) return false;
  if (typeof request.core_version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,63}$/.test(request.core_version)) return false;
  if (!new Set(["lm-studio", "omlx", "exo", "mtplx"]).has(String(request.runtime_family))) return false;
  if (!Number.isSafeInteger(request.declared_max_concurrency)
    || (request.declared_max_concurrency as number) < 1 || (request.declared_max_concurrency as number) > 1_000) return false;
  if (!Array.isArray(request.selected_models) || request.selected_models.length < 1 || request.selected_models.length > 100) return false;
  const ids = new Set<string>();
  for (const value of request.selected_models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const model = value as Record<string, unknown>;
    if (Object.keys(model).length !== 2 || !("reported_id" in model) || !("modalities" in model)
      || !isValidProviderSelectedModelId(model.reported_id) || ids.has(model.reported_id)) return false;
    ids.add(model.reported_id);
    if (!Array.isArray(model.modalities) || model.modalities.length < 1 || model.modalities.length > 16
      || new Set(model.modalities).size !== model.modalities.length
      || model.modalities.some((modality) => typeof modality !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,31}$/.test(modality))) return false;
  }
  return true;
}

function providerCloudApiUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("provider Cloud API URL is invalid"); }
  const production = parsed.protocol === "https:" && parsed.host === "api.multivibe.cloud";
  const loopback = parsed.protocol === "http:" && Boolean(parsed.port) && ["127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((!production && !loopback) || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) throw new Error("provider Cloud API URL is invalid");
  return parsed.origin;
}

export function startEmbeddedProviderAgent(options: {
  enabled: boolean;
  binaryPath: string;
  environment?: NodeJS.ProcessEnv;
  statePath?: string;
  runtimeStatePath?: string;
  deviceKeyPath?: string;
  enrollmentStatePath?: string;
  cloudApiUrl?: string;
  restartLimit?: number;
}): ProviderAgentSupervisor {
  const unavailable = async (): Promise<never> => { throw new Error("provider agent is not enabled"); };
  if (!options.enabled) return {
    enabled: false,
    stop: async () => undefined,
    getManifest: unavailable,
    getSelection: unavailable,
    replaceSelection: unavailable,
    getAdapters: unavailable,
    getRuntimeEndpoints: unavailable,
    replaceRuntimeEndpoints: unavailable,
    detectModels: unavailable,
    getCloudEnrollment: unavailable,
    enrollCloud: unavailable,
    openRelayShadowSession: unavailable,
  };
  if (!path.isAbsolute(options.binaryPath)) throw new Error("provider agent binary path must be absolute");
  if (options.statePath && (!path.isAbsolute(options.statePath) || path.normalize(options.statePath) !== options.statePath)) {
    throw new Error("provider agent state path must be a clean absolute path");
  }
  if (options.runtimeStatePath && (!path.isAbsolute(options.runtimeStatePath)
    || path.normalize(options.runtimeStatePath) !== options.runtimeStatePath)) {
    throw new Error("provider agent runtime state path must be a clean absolute path");
  }
  if (options.deviceKeyPath && (!path.isAbsolute(options.deviceKeyPath)
    || path.normalize(options.deviceKeyPath) !== options.deviceKeyPath)) {
    throw new Error("provider agent device key path must be a clean absolute path");
  }
  if (options.enrollmentStatePath && (!path.isAbsolute(options.enrollmentStatePath)
    || path.normalize(options.enrollmentStatePath) !== options.enrollmentStatePath)) {
    throw new Error("provider agent enrollment state path must be a clean absolute path");
  }
  const cloudApiUrl = providerCloudApiUrl(options.cloudApiUrl ?? "https://api.multivibe.cloud");
  const sourceEnvironment = options.environment ?? process.env;
  const controlToken = randomBytes(32).toString("base64url");
  const listenAddress = sourceEnvironment.MULTIVIBE_PROVIDER_AGENT_LISTEN ?? "127.0.0.1:1460";
  if (listenAddress !== "127.0.0.1:1460" && listenAddress !== "[::1]:1460") {
    throw new Error("provider agent listen address must use literal loopback port 1460");
  }
  const baseUrl = listenAddress === "[::1]:1460" ? "http://[::1]:1460" : "http://127.0.0.1:1460";
  const request = async <T>(route: string, init: RequestInit = {}, acceptedStatuses: readonly number[] = [200, 409]): Promise<{ response: Response; value: T }> => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${controlToken}`, ...(init.headers ?? {}) },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!acceptedStatuses.includes(response.status)) {
      if ([400, 404, 409].includes(response.status)) throw new ProviderAgentControlRequestError(response.status);
      throw new Error("provider agent control request failed");
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > 64 * 1024) throw new Error("provider agent control response is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("provider agent control response is too large");
    return { response, value: JSON.parse(text) as T };
  };
  let child: ChildProcess | undefined;
  let stopped = false;
  let restarts = 0;
  const restartLimit = options.restartLimit ?? 5;
  const launch = () => {
    if (stopped) return;
    child = spawn(options.binaryPath, [], {
      env: providerAgentChildEnvironment(
        sourceEnvironment, options.statePath, controlToken, options.runtimeStatePath, options.deviceKeyPath,
        options.enrollmentStatePath, cloudApiUrl,
      ),
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("exit", () => {
      child = undefined;
      if (!stopped && restarts < restartLimit) {
        restarts += 1;
        setTimeout(launch, Math.min(1_000 * restarts, 5_000)).unref();
      }
    });
  };
  launch();
  return {
    enabled: true,
    getManifest: async () => (await request<ProviderAgentManifest>("/v1/manifest")).value,
    getSelection: async () => (await request<ProviderAgentSelection>("/v1/selection")).value,
    replaceSelection: async (revision, selectedModels) => {
      const result = await request<ProviderAgentSelection>("/v1/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, selected_models: selectedModels }),
      });
      return { conflict: result.response.status === 409, selection: result.value };
    },
    getAdapters: async () => (await request<ProviderAgentAdapterRegistry>("/v1/adapters")).value,
    getRuntimeEndpoints: async () => (await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints")).value,
    replaceRuntimeEndpoints: async (revision, endpoints) => {
      const result = await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, endpoints }),
      });
      return { conflict: result.response.status === 409, endpoints: result.value };
    },
    detectModels: async () => (await request<ProviderAgentDetectedModels>("/v1/detected-models")).value,
    getCloudEnrollment: async () => (await request<ProviderCloudEnrollmentView>("/v1/cloud-shadow/enrollment", {}, [200])).value,
    enrollCloud: async (enrollment) => (await request<ProviderCloudEnrollmentView>("/v1/cloud-shadow/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(enrollment),
    }, [201])).value,
    openRelayShadowSession: async (session) => (await request<SignedProviderRelayShadowSession>("/v1/relay-shadow/session-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session),
    })).value,
    stop: async () => {
      stopped = true;
      const running = child;
      if (!running || running.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5_000);
        timeout.unref();
        running.once("exit", () => { clearTimeout(timeout); resolve(); });
        running.kill("SIGTERM");
      });
    },
  };
}
