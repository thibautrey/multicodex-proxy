# Integrating deferred batch jobs

MultiVibe can accept a non-streaming inference request now, persist it as a
durable job, and execute it later when its priority and routing policy allow.
This is intended for translations, catalog enrichment, indexing, reporting,
and other work where a result does not have to be returned in the original
HTTP request.

This guide is for application developers integrating an existing project with
the public MultiVibe API. For the server-side routing and alias schema, see the
smart alias section in the main [README](../README.md#-routing-strategy).

## Key behavior

- A deferred request returns `202 Accepted` with a `multivibe.job` object.
- Batch jobs submitted outside the default execution window become eligible at
  22:00 Europe/Paris. The window ends at 07:00.
- Jobs are durable across MultiVibe restarts and are isolated by application
  API key.
- Scheduling is weighted across priorities (`critical`, `interactive`,
  `standard`, `batch`) and then across applications of the same priority.
- A job is executed at least once. Transient failures are attempted up to three
  times; application-side result handling must therefore also be idempotent.
- Streaming Responses, streaming Chat Completions, WebSocket, and Realtime
  requests cannot be deferred.

Examples below use `multivibe-batch`. This is a deployment-level smart alias,
not a model built into MultiVibe. The deployment must configure that alias with
an admissible local or cloud candidate before applications use it.

## Recommended request flow

1. Generate a stable idempotency key for the business operation.
2. Submit a non-streaming request with explicit `batch` and `defer` headers.
3. Persist the returned MultiVibe job ID next to the local business record.
4. Poll the job or subscribe to its SSE event stream.
5. Fetch the result when the job reaches `succeeded`.
6. Apply the result idempotently and mark the local operation complete.

Persisting the job ID is essential. A process restart must resume monitoring
the existing job rather than create unrelated work.

## Submit a job

The same mechanism is available on Responses, Chat Completions, and Anthropic
Messages routes. The request must not enable streaming.

```bash
curl -X POST "$MULTIVIBE_BASE_URL/v1/responses" \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-MultiVibe-Priority: batch" \
  -H "X-MultiVibe-Execution: defer" \
  -H "X-MultiVibe-Idempotency-Key: translation:product-42:fr:v3" \
  -H "X-MultiVibe-Deadline: 2026-08-28T07:00:00+02:00" \
  -d '{
    "model": "multivibe-batch",
    "input": "Translate the supplied product description into French."
  }'
```

Always send `X-MultiVibe-Priority: batch` and
`X-MultiVibe-Execution: defer` when also sending an idempotency key, deadline,
maximum wait, or webhook header. The presence of any routing header makes the
request explicit, so alias defaults are no longer applied to missing fields.

The deadline is optional. When provided, it must be an RFC 3339 timestamp and
must leave enough time for the next batch window. An expired deadline is
rejected, and a queued job that reaches its deadline becomes `expired`.

A successful submission returns `202` and headers similar to:

```text
X-MultiVibe-Decision: queued
X-MultiVibe-Priority: batch
X-MultiVibe-Resolved-Model: multivibe-batch
X-MultiVibe-Estimated-Wait-Ms: 17400000
X-MultiVibe-Capacity-Version: 42
Location: /v1/jobs/68f0b7c0-...
```

The response body is a job resource:

```json
{
  "object": "multivibe.job",
  "id": "68f0b7c0-7e76-4c66-9ee8-24b3f014c17c",
  "status": "queued",
  "priority": "batch",
  "model": "multivibe-batch",
  "attempts": 0,
  "created_at": "2026-08-26T15:20:00.000Z",
  "updated_at": "2026-08-26T15:20:00.000Z",
  "not_before": "2026-08-26T20:00:00.000Z",
  "deadline": "2026-08-28T05:00:00.000Z",
  "result_url": "/v1/jobs/68f0b7c0-7e76-4c66-9ee8-24b3f014c17c/result",
  "events_url": "/v1/jobs/68f0b7c0-7e76-4c66-9ee8-24b3f014c17c/events"
}
```

Timestamps in job resources are UTC. In the example, `20:00Z` is 22:00 in
Europe/Paris during daylight-saving time.

## Idempotency

`X-MultiVibe-Idempotency-Key` is scoped to the authenticated application and
may contain at most 200 characters. Repeating a submission with the same key
returns the original job instead of creating another one.

Use a deterministic key derived from the business entity, target operation,
locale or variant, and source revision, for example:

```text
translation:<product-id>:<locale>:<source-revision>
```

Do not reuse a key for a different payload. MultiVibe deduplicates by key; it
does not compare payload hashes. Do not include secrets or personal data in the
key because it may appear in operational metadata.

## Observe job state

List the current application's jobs:

```http
GET /v1/jobs?limit=100
```

`limit` is clamped to the range 1–500. Fetch one job with:

```http
GET /v1/jobs/:id
```

Both endpoints require the same application API key that submitted the job.
A job owned by another application is returned as `404`, preventing cross-
application discovery.

| Status | Meaning | Application action |
|---|---|---|
| `queued` | Waiting for its time window or capacity | Keep waiting |
| `running` | Leased by a worker | Keep waiting; do not resubmit |
| `retry` | A transient attempt failed | Keep waiting |
| `succeeded` | Result is available | Fetch `/result` |
| `failed` | Attempts are exhausted or the error is permanent | Record failure and alert/review |
| `cancelled` | Cancellation was accepted | Stop monitoring |
| `expired` | The deadline or retention limit was reached | Decide whether to submit new work with a new key |

For polling, start around 2 seconds and back off to 30–60 seconds. Add jitter
when many jobs may complete together. Network failures and `5xx` responses from
the status endpoint should retry the status check; they must not trigger a new
inference submission.

## Receive progress with SSE

Subscribe to:

```http
GET /v1/jobs/:id/events
Accept: text/event-stream
```

Events include `job.queued`, `job.started`, `job.capacity_wait`, `job.retry`,
`job.succeeded`, `job.failed`, `job.cancelled`, and `job.expired`. Each event
has an integer SSE ID. Save the latest ID and reconnect with:

```http
Last-Event-ID: <last-seen-id>
```

The server emits a heartbeat comment every 15 seconds. Treat SSE as a prompt to
refresh job state, not as the only source of truth: reconnect after failures
and periodically reconcile durable local records through `GET /v1/jobs/:id`.

## Retrieve a result

After the job is `succeeded`, request:

```http
GET /v1/jobs/:id/result
```

The body is the normal upstream response for the original inference protocol.
Relevant upstream request IDs and content type are restored on the response.

Possible responses are:

- `200`: the result was delivered and marked consumed;
- `409`: the job is not ready yet, with the current job in the response;
- `410`: the job ended as `failed`, `cancelled`, or `expired`;
- `404`: no job is visible to this application.

Store and apply the result transactionally where possible. If the application
crashes after fetching the result but before committing its own state, it must
be safe to repeat its local apply step.

## Cancel a job

```http
DELETE /v1/jobs/:id
```

- `204`: cancellation was accepted;
- `409`: the job can no longer be cancelled;
- `404`: the job does not exist for this application.

Cancellation is best effort for a running upstream request. Do not assume that
external side effects can be rolled back.

## Optional signed webhook

An administrator must pre-register each webhook URL for an application. The
application can then submit the returned webhook ID:

```text
X-MultiVibe-Webhook: <registered-webhook-id>
```

The callback body has this shape:

```json
{
  "id": "event-id",
  "type": "job.completed",
  "createdAt": "2026-08-26T22:14:12.000Z",
  "data": {
    "job": { "object": "multivibe.job", "status": "succeeded" },
    "result": {}
  }
}
```

MultiVibe sends:

```text
X-MultiVibe-Event-Id: <event-id>
X-MultiVibe-Signature: sha256=<hex HMAC-SHA256 of the exact request body>
```

Verify the signature with a constant-time comparison before parsing or acting
on the payload. Deduplicate callbacks by event ID. MultiVibe does not follow
redirects and retries failed delivery with exponential backoff for up to 24
hours. A successful `2xx` delivery marks the result delivered.

## Reliability and retention

- Jobs and leases are stored in SQLite using WAL mode.
- Worker leases are renewed during execution and recovered after a restart.
- Transient upstream errors and `429`/`5xx` responses are retried up to three
  total attempts with exponential backoff.
- Waiting for capacity reschedules the job without consuming an attempt.
- Reading a result or successfully delivering its webhook starts a one-hour
  grace period before payload and result content can be purged.
- Unretrieved content is purged after 30 days as a safety limit.
- Request payloads and results are stored in clear text in the protected
  `/data/jobs.sqlite` volume. Do not submit content that violates the
  deployment's data-handling policy.

## Migration checklist for an existing project

- Identify operations that are non-interactive and do not use streaming.
- Keep interactive paths on their current synchronous model.
- Add configuration for the MultiVibe base URL, application API key, batch
  alias, and a feature flag.
- Persist the MultiVibe job ID, idempotency key, status, attempts, and last
  error in the project's existing durable store.
- Separate job submission from result monitoring so both survive restarts.
- Make result application idempotent.
- Add bounded polling or SSE reconnection with reconciliation.
- Handle every terminal state explicitly.
- Avoid logging authorization headers, source payloads, or model results.
- Cover submission, deduplication, restart recovery, success, terminal failure,
  expiry, cancellation, and malformed responses in automated tests.

For a self-contained task specification that can be given to a coding agent,
use [the batch integration prompt](prompts/implement-multivibe-batch.md).
