export type HttpMethod = "GET" | "POST" | "DELETE";

export type EndpointGroup =
  | "Models"
  | "Inference"
  | "Smart routing"
  | "Observability"
  | "Configuration";

export type ApiField = {
  name: string;
  type: string;
  description: string;
  example?: string;
  required?: boolean;
};

export type ApiEndpoint = {
  id: string;
  group: EndpointGroup;
  method: HttpMethod;
  path: string;
  title: string;
  summary: string;
  description: string;
  pathParams?: ApiField[];
  queryParams?: ApiField[];
  requestBody?: string;
  responseExample: string;
  note?: string;
  destructive?: boolean;
};

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export const GROUPS: EndpointGroup[] = [
  "Models",
  "Inference",
  "Smart routing",
  "Observability",
  "Configuration",
];

export const ENDPOINTS: ApiEndpoint[] = [
  {
    id: "list-models",
    group: "Models",
    method: "GET",
    path: "/v1/models",
    title: "List models",
    summary: "Discover every model and alias currently exposed by the proxy.",
    description:
      "Returns an OpenAI-compatible model collection enriched with provider capabilities and alias metadata.",
    responseExample: json({
      object: "list",
      data: [
        {
          id: "gpt-5.3-codex",
          object: "model",
          owned_by: "multivibe",
          metadata: { supports_reasoning: true },
        },
      ],
    }),
  },
  {
    id: "retrieve-model",
    group: "Models",
    method: "GET",
    path: "/v1/models/:id",
    title: "Retrieve a model",
    summary: "Inspect one model by its exposed identifier.",
    description:
      "Returns the same capability metadata as the list endpoint for a single model or alias.",
    pathParams: [
      {
        name: "id",
        type: "string",
        required: true,
        description: "Exposed model or alias identifier.",
        example: "{{model}}",
      },
    ],
    responseExample: json({
      id: "{{model}}",
      object: "model",
      owned_by: "multivibe",
    }),
  },
  {
    id: "create-response",
    group: "Inference",
    method: "POST",
    path: "/v1/responses",
    title: "Create a response",
    summary: "Generate text or tool calls through the Responses API.",
    description:
      "The recommended interface for new integrations. Requests are routed to an eligible provider while preserving the OpenAI Responses shape.",
    requestBody: json({
      model: "{{model}}",
      input: "Explain in one sentence what MultiVibe does.",
      stream: false,
    }),
    responseExample: json({
      id: "resp_...",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "..." }],
        },
      ],
    }),
    note:
      "Set stream to true for server-sent events. The console defaults to false so the complete JSON response remains easy to inspect.",
  },
  {
    id: "create-chat-completion",
    group: "Inference",
    method: "POST",
    path: "/v1/chat/completions",
    title: "Create a chat completion",
    summary: "Use the familiar OpenAI Chat Completions contract.",
    description:
      "Accepts role-based messages and bridges them to the selected upstream interface when necessary.",
    requestBody: json({
      model: "{{model}}",
      messages: [{ role: "user", content: "Say hello in one sentence." }],
      stream: false,
    }),
    responseExample: json({
      id: "chatcmpl_...",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
        },
      ],
    }),
  },
  {
    id: "create-message",
    group: "Inference",
    method: "POST",
    path: "/v1/messages",
    title: "Create an Anthropic message",
    summary: "Call the proxy with the Anthropic Messages format.",
    description:
      "Provides an Anthropic-compatible envelope while keeping MultiVibe routing, attribution and tracing.",
    requestBody: json({
      model: "{{model}}",
      max_tokens: 256,
      messages: [{ role: "user", content: "What can this proxy do?" }],
    }),
    responseExample: json({
      id: "msg_...",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      stop_reason: "end_turn",
    }),
  },
  {
    id: "compact-response",
    group: "Inference",
    method: "POST",
    path: "/v1/responses/compact",
    title: "Compact a conversation",
    summary: "Reduce conversation context while preserving relevant state.",
    description:
      "Creates a compacted context item suitable for continuing a long-running Responses conversation.",
    requestBody: json({
      model: "{{model}}",
      input: [
        {
          role: "user",
          content: "Summarize the important context.",
        },
      ],
    }),
    responseExample: json({
      id: "resp_...",
      object: "response.compaction",
      output: [{ type: "compaction", encrypted_content: "..." }],
    }),
  },
  {
    id: "capacity",
    group: "Smart routing",
    method: "GET",
    path: "/v1/capacity",
    title: "Inspect capacity",
    summary: "Preview admission capacity for a model and priority.",
    description:
      "Returns a point-in-time capacity snapshot. The request-time admission decision remains authoritative.",
    queryParams: [
      {
        name: "model",
        type: "string",
        required: true,
        description: "Model or smart alias to evaluate.",
        example: "{{model}}",
      },
      {
        name: "priority",
        type: "enum",
        description: "critical, interactive, standard or batch.",
        example: "interactive",
      },
    ],
    responseExample: json({
      object: "multivibe.capacity",
      model: "{{model}}",
      application: "dashboard",
      priority: "interactive",
      state: "ready",
      decision: "local",
      freeSlots: 3,
      estimatedWaitMs: 0,
      queueDepth: 0,
      recommendation: "sync",
      version: 42,
      confidence: "observed",
    }),
  },
  {
    id: "list-jobs",
    group: "Smart routing",
    method: "GET",
    path: "/v1/jobs",
    title: "List deferred jobs",
    summary: "List jobs belonging to the authenticated application.",
    description:
      "Returns deferred inference jobs in reverse chronological order with their lifecycle state.",
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of jobs to return.",
        example: "25",
      },
    ],
    responseExample: json({
      object: "list",
      data: [
        {
          id: "job_...",
          object: "multivibe.job",
          status: "succeeded",
        },
      ],
    }),
  },
  {
    id: "retrieve-job",
    group: "Smart routing",
    method: "GET",
    path: "/v1/jobs/:id",
    title: "Retrieve a job",
    summary: "Read the current state and metadata for one deferred job.",
    description:
      "The job must belong to the application resolved from the current authentication context.",
    pathParams: [
      {
        name: "id",
        type: "string",
        required: true,
        description: "Deferred job identifier.",
        example: "job_...",
      },
    ],
    responseExample: json({
      id: "job_...",
      object: "multivibe.job",
      status: "running",
      created_at: 1788268922000,
    }),
  },
  {
    id: "retrieve-job-result",
    group: "Smart routing",
    method: "GET",
    path: "/v1/jobs/:id/result",
    title: "Retrieve a job result",
    summary: "Fetch the completed inference payload for a deferred job.",
    description:
      "Returns the original inference response once the job reaches a completed state.",
    pathParams: [
      {
        name: "id",
        type: "string",
        required: true,
        description: "Completed deferred job identifier.",
        example: "job_...",
      },
    ],
    responseExample: json({
      id: "resp_...",
      object: "response",
      status: "completed",
      output: [],
    }),
  },
  {
    id: "cancel-job",
    group: "Smart routing",
    method: "DELETE",
    path: "/v1/jobs/:id",
    title: "Cancel a job",
    summary: "Cancel a queued or running deferred job.",
    description:
      "Cancellation is scoped to the authenticated application. The console asks for confirmation before sending.",
    pathParams: [
      {
        name: "id",
        type: "string",
        required: true,
        description: "Deferred job identifier.",
        example: "job_...",
      },
    ],
    responseExample: "No response body (204).",
    destructive: true,
  },
  {
    id: "list-traces",
    group: "Observability",
    method: "GET",
    path: "/admin/traces",
    title: "List traces",
    summary: "Inspect paginated request traces captured by the proxy.",
    description:
      "Returns lightweight trace rows with route, model, status, latency, token and cost information.",
    queryParams: [
      {
        name: "page",
        type: "integer",
        description: "One-based page number.",
        example: "1",
      },
      {
        name: "pageSize",
        type: "integer",
        description: "Rows per page.",
        example: "25",
      },
      {
        name: "sinceMs",
        type: "epoch ms",
        description: "Optional inclusive start time.",
      },
      {
        name: "untilMs",
        type: "epoch ms",
        description: "Optional inclusive end time.",
      },
    ],
    responseExample: json({
      traces: [
        {
          id: "...",
          route: "POST /v1/responses",
          status: 200,
          latencyMs: 842,
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1 },
    }),
  },
  {
    id: "usage-stats",
    group: "Observability",
    method: "GET",
    path: "/admin/stats/usage",
    title: "Get usage statistics",
    summary: "Aggregate requests, tokens, latency and cost by dimension.",
    description:
      "Combine filters to analyze a provider account, route, application or registered project over a time range.",
    queryParams: [
      {
        name: "sinceMs",
        type: "epoch ms",
        description: "Inclusive start time.",
      },
      {
        name: "untilMs",
        type: "epoch ms",
        description: "Inclusive end time.",
      },
      {
        name: "accountId",
        type: "string",
        description: "Filter by provider account.",
      },
      {
        name: "route",
        type: "string",
        description: "Filter by recorded route.",
      },
      {
        name: "application",
        type: "string",
        description: "Filter by proxy-key application.",
      },
      {
        name: "projectId",
        type: "string",
        description: "Filter by registered Codex project.",
      },
    ],
    responseExample: json({
      ok: true,
      totals: {
        requests: 128,
        errors: 2,
        tokens: { input: 42000, output: 8300 },
        costUsd: 1.42,
      },
      byAccount: [],
      byRoute: [],
      byApplication: [],
      byProject: [],
    }),
  },
  {
    id: "trace-stats",
    group: "Observability",
    method: "GET",
    path: "/admin/stats/traces",
    title: "Get trace statistics",
    summary: "Read historical time-series and model-level trace metrics.",
    description:
      "Provides dashboard-ready totals, latency distributions, cost estimates and account-selection statistics.",
    queryParams: [
      {
        name: "sinceMs",
        type: "epoch ms",
        description: "Inclusive start time.",
      },
      {
        name: "untilMs",
        type: "epoch ms",
        description: "Inclusive end time.",
      },
    ],
    responseExample: json({
      ok: true,
      totalStored: 128,
      matched: 128,
      stats: {
        totals: { requests: 128, errors: 2, latencyAvgMs: 842 },
        models: [],
        timeseries: [],
        accountSelection: { attempts: 128, rotations: 3 },
      },
    }),
  },
  {
    id: "list-projects",
    group: "Observability",
    method: "GET",
    path: "/admin/codex-projects",
    title: "List Codex projects",
    summary: "List projects discovered through Codex session attribution.",
    description:
      "Returns normalized project identity, repository metadata and the number of registered sessions.",
    responseExample: json({
      ok: true,
      projects: [
        {
          id: "...",
          name: "multivibe",
          root: "/workspace/multivibe",
          sessionCount: 4,
        },
      ],
    }),
  },
  {
    id: "list-sessions",
    group: "Observability",
    method: "GET",
    path: "/admin/codex-sessions",
    title: "List Codex sessions",
    summary: "Inspect session-to-project attribution records.",
    description:
      "Useful for diagnosing which Codex sessions contribute to project-level usage statistics.",
    responseExample: json({
      ok: true,
      sessions: [
        {
          sessionId: "...",
          projectId: "...",
          firstSeenAt: 1788268922000,
        },
      ],
    }),
  },
  {
    id: "list-accounts",
    group: "Configuration",
    method: "GET",
    path: "/admin/accounts",
    title: "List provider accounts",
    summary: "Read configured provider accounts and their live quota state.",
    description:
      "Sensitive credentials are omitted. The result includes routing state, identity and cached usage data.",
    responseExample: json({
      accounts: [
        {
          id: "...",
          provider: "openai",
          enabled: true,
          usage: {},
        },
      ],
    }),
  },
  {
    id: "list-aliases",
    group: "Configuration",
    method: "GET",
    path: "/admin/model-aliases",
    title: "List model aliases",
    summary: "Read smart routing rules and fallback candidates.",
    description:
      "Returns versioned alias definitions, matching constraints, objectives and ordered provider candidates.",
    responseExample: json({
      modelAliases: [
        {
          schemaVersion: 2,
          id: "smart-coding",
          enabled: true,
          rules: [],
        },
      ],
    }),
  },
  {
    id: "list-api-keys",
    group: "Configuration",
    method: "GET",
    path: "/admin/proxy-api-keys",
    title: "List application API keys",
    summary: "List key metadata without exposing stored secrets.",
    description:
      "Dashboard-created and environment-provided keys are returned with masked previews and source metadata.",
    responseExample: json({
      proxyApiKeys: [
        {
          id: "...",
          application: "staging-worker",
          keyPreview: "mv_••••9f2a",
        },
      ],
    }),
  },
  {
    id: "application-policies",
    group: "Configuration",
    method: "GET",
    path: "/admin/application-policies",
    title: "List application policies",
    summary: "Inspect fairness weights and registered result webhooks.",
    description:
      "Policies are keyed by application and control admission fairness plus deferred-job webhook delivery.",
    responseExample: json({
      applicationPolicies: [
        {
          application: "staging-worker",
          fairnessWeight: 1,
          webhooks: [],
        },
      ],
    }),
  },
  {
    id: "get-settings",
    group: "Configuration",
    method: "GET",
    path: "/admin/settings",
    title: "Get proxy settings",
    summary: "Read persisted routing and passthrough settings.",
    description:
      "Returns operator-managed defaults such as passthrough-account and image-routing overrides.",
    responseExample: json({
      ok: true,
      settings: {
        defaultPassthroughAccountId: "...",
        imageRequestModelOverride: "...",
      },
    }),
  },
  {
    id: "get-config",
    group: "Configuration",
    method: "GET",
    path: "/admin/config",
    title: "Get runtime capabilities",
    summary: "Read non-secret runtime configuration used by the dashboard.",
    description:
      "Includes OAuth availability, storage information and proxy capability flags without returning credentials.",
    responseExample: json({
      ok: true,
      oauthRedirectUri: "https://proxy.example/auth/callback",
      storage: { persistenceLikelyEnabled: true },
    }),
  },
];
