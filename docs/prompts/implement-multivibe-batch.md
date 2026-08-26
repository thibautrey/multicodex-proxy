# Prompt: implement MultiVibe batch processing in an existing project

Copy the prompt below into a coding agent and replace the bracketed values. It
is intentionally implementation-oriented and does not assume a programming
language or framework.

---

You are working in the existing project `[PROJECT_NAME]`.

Implement durable asynchronous processing for `[WORKFLOW_TO_DEFER]` using the
MultiVibe deferred batch API. First inspect the repository, its local agent
instructions, current inference client, persistence layer, background worker
mechanism, tests, and deployment configuration. Reuse established project
patterns and dependencies where practical.

## Goal

Move only the non-interactive `[WORKFLOW_TO_DEFER]` operation from synchronous
inference to a durable submit-and-collect workflow. Interactive and streaming
features must retain their current behavior. The integration must recover
after application restarts without duplicating business work.

Use these deployment values:

- MultiVibe base URL: `[MULTIVIBE_BASE_URL]`
- Batch model alias: `multivibe-batch`
- API key source: `[SECRET_MANAGER_OR_ENVIRONMENT_VARIABLE]`
- Optional registered webhook ID: `[WEBHOOK_ID_OR_NONE]`
- Desired completion deadline: `[DEADLINE_POLICY_OR_NONE]`

Never hardcode, print, log, commit, or return the API key. Reuse the project's
secret-management convention.

## MultiVibe API contract

Submit the project's existing non-streaming inference payload to the matching
MultiVibe endpoint, normally one of:

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`

Set the payload model to `multivibe-batch`, ensure streaming is absent or
false, and always send:

```text
Authorization: Bearer <application API key>
X-MultiVibe-Priority: batch
X-MultiVibe-Execution: defer
X-MultiVibe-Idempotency-Key: <stable business-operation key>
```

When configured, also send:

```text
X-MultiVibe-Deadline: <RFC 3339 timestamp>
X-MultiVibe-Webhook: <pre-registered webhook ID>
```

Always send both priority and execution headers. Sending any other
`X-MultiVibe-*` header makes the request explicit and prevents omitted fields
from inheriting alias defaults.

A deferred submission returns `202 Accepted` with:

```json
{
  "object": "multivibe.job",
  "id": "uuid",
  "status": "queued",
  "priority": "batch",
  "model": "multivibe-batch",
  "attempts": 0,
  "created_at": "RFC3339 timestamp",
  "updated_at": "RFC3339 timestamp",
  "not_before": "RFC3339 timestamp",
  "deadline": "optional RFC3339 timestamp",
  "result_url": "/v1/jobs/<id>/result",
  "events_url": "/v1/jobs/<id>/events"
}
```

The default batch execution window is 22:00–07:00 Europe/Paris. Jobs submitted
outside it remain queued until the next window. The application must not
implement its own duplicate nightly scheduler unless its product requirements
need an additional restriction.

Job endpoints, authenticated with the same application API key, are:

- `GET /v1/jobs?limit=100`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/result`
- `GET /v1/jobs/:id/events` using SSE and `Last-Event-ID`
- `DELETE /v1/jobs/:id`

Job statuses are `queued`, `running`, `retry`, `succeeded`, `failed`,
`cancelled`, and `expired`.

On `GET /result`, treat `200` as a delivered result, `409` as not ready, `410`
as a terminal failed/cancelled/expired job, and `404` as absent or not visible
to this application. Cancellation returns `204`, `409`, or `404`.

MultiVibe provides at-least-once execution and up to three attempts for
transient errors. Capacity waits do not consume an attempt. A stable
idempotency key is scoped to the application and deduplicates submissions, but
MultiVibe does not compare payload hashes. Never reuse the same key for a
different payload.

## Required implementation

1. Find the exact synchronous call(s) used by `[WORKFLOW_TO_DEFER]`. Document
   which call sites will change and which interactive call sites will remain
   synchronous.
2. Add configuration using the project's conventions. Prefer names equivalent
   to:
   - `MULTIVIBE_BASE_URL`
   - `MULTIVIBE_API_KEY`
   - `MULTIVIBE_BATCH_MODEL` with default `multivibe-batch`
   - `MULTIVIBE_BATCH_ENABLED` for a controlled rollout
   - bounded polling interval and deadline settings where appropriate.
3. Derive an idempotency key from immutable business identifiers plus the
   source revision, locale/variant, and operation version. Keep it under 200
   characters and exclude secrets and personal data.
4. Persist, in the project's existing durable store, at least:
   - local business operation ID;
   - MultiVibe job ID;
   - idempotency key;
   - remote status;
   - submission and update timestamps;
   - attempt/error metadata useful to operators;
   - whether the result has been applied locally.
5. Separate submission from monitoring. If submission times out after the
   request may have reached MultiVibe, retry with the same idempotency key.
   Never create a new key merely because the HTTP response was lost.
6. Implement restart-safe reconciliation. On startup or worker recovery,
   resume every non-terminal local record with a remote job ID. Do not resubmit
   jobs already known to MultiVibe.
7. Poll with exponential or bounded backoff and jitter, or implement the SSE
   endpoint with `Last-Event-ID`. Even with SSE, periodically reconcile with
   `GET /v1/jobs/:id`; SSE is not the durable source of truth.
8. Fetch `/result` only after `succeeded`. Validate the response before applying
   it. Apply the result idempotently and commit the result and local completion
   marker atomically where the persistence layer supports transactions.
9. Handle `failed`, `cancelled`, `expired`, malformed responses, authentication
   failures, `429`, network failures, and `5xx` responses explicitly. Status
   check failures should retry status checks and must not create new inference
   work.
10. If the project exposes cancellation, map it to `DELETE /v1/jobs/:id` and
    make the best-effort semantics clear.
11. Preserve the previous synchronous implementation behind the rollout flag
    long enough to roll back safely. Do not silently fall back to synchronous
    cloud inference after a batch submission has been accepted.
12. Add structured observability without sensitive payloads: local operation
    ID, remote job ID, state transition, elapsed time, and sanitized error
    category. Never log authorization headers, full prompts, or results.

If the project has no durable database or worker mechanism, do not hide that
limitation with in-memory state. Implement the smallest repository-appropriate
durable solution, or stop and clearly report the architectural decision that
needs approval.

## Tests

Add automated tests using an HTTP mock or local test server; tests must not call
production MultiVibe. Cover at least:

- correct URL, model, non-streaming payload, and required headers;
- stable idempotency key generation;
- `202` submission and local job persistence;
- a lost submission response followed by same-key retry;
- queued/running/retry polling without resubmission;
- restart recovery from persisted state;
- successful result retrieval and exactly-once local application;
- duplicate success notification or repeated reconciliation;
- failed, cancelled, and expired terminal states;
- `409`, `410`, `404`, `429`, timeout, connection failure, malformed JSON, and
  `5xx` behavior;
- cancellation if supported;
- feature flag disabled, preserving the current synchronous behavior;
- secrets and inference payloads absent from logs.

Run the relevant existing test, lint, type-check, and build commands. Do not
weaken tests or unrelated behavior to make the change pass.

## Deliverables

Implement the change rather than only proposing it. At completion, report:

- the architecture and workflow chosen;
- every file changed;
- configuration and secret-manager changes required at deployment time;
- any database migration and rollback considerations;
- tests and verification commands run with their results;
- remaining risks or decisions that genuinely require a maintainer.

Do not deploy, rotate credentials, create production jobs, or modify unrelated
inference paths unless explicitly authorized.

---

Before using this prompt, replace every bracketed placeholder. If the project
already has a durable queue, use it to monitor MultiVibe jobs rather than
building a competing scheduler.
