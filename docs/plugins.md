# MultiVibe plugins

MultiVibe plugins are versioned JavaScript modules that participate in the
inference lifecycle. A plugin can inspect or replace a request or response and
can stop processing by returning its own HTTP response. Plugins execute inside
the MultiVibe process: they are an extension mechanism, not a security
sandbox.

This guide covers installation and operations, the v1 manifest and hook API,
and the minimum structure needed to publish a plugin.

## Trust and compatibility

Only install repositories whose code and maintainers you trust. A plugin has
the same filesystem, network, environment, and process access as MultiVibe. It
can read provider credentials and request content. The installer performs
structural checks, but these do not make third-party code safe:

- the URL must identify a public GitHub repository over HTTPS;
- credentials, query strings, fragments, submodules, and non-GitHub hosts are rejected;
- the repository is capped at 256 MiB and an individual file at 128 MiB;
- symlinks may not escape the checkout;
- the entrypoint must stay inside the repository; and
- the manifest must target the supported module API version.

MultiVibe clones the repository's current default-branch commit and records the
exact SHA in `/data/modules/modules-lock.json`. It never updates a plugin
automatically. Review upstream changes before selecting **Update**.

## Install and operate a plugin

Open `http://localhost:1455/?tab=plugins` (replace the origin for a remote
deployment), then:

1. Paste a public `https://github.com/owner/repository` URL.
2. Select **Install and pin**. A new third-party plugin starts disabled.
3. Restart MultiVibe when the card displays **Restart required**.
4. Select **Enable** to use the plugin for new requests.

The plugin cards expose their origin, pinned commit, version, declared hooks,
health, and load state.

The **Marketplace** view is designed for larger catalogs: search matches names,
descriptions, authors, IDs, categories, and tags, while category chips narrow
the result grid. Select **Install** on a catalog card to clone and pin that
plugin without re-entering its URL. The separate **Installed** view retains the
runtime controls and health information.

### Submit a plugin

Select **Submit a plugin**, enter the public GitHub repository URL, then choose
**Validate and submit**. MultiVibe clones a temporary snapshot, validates the
same safety and compatibility rules used during installation, reads its
marketplace metadata, and adds or refreshes the entry in this deployment's
catalog. Submission does not install or execute the plugin.

Marketplace submissions are stored in `/data/modules/marketplace.json`. This
is an instance-local registry: operators can curate their own catalog and move
it with their `/data` backup. The submission API is protected by the same admin
authentication as the rest of the dashboard.

| Action | Effect |
| --- | --- |
| **Enable** | Makes a loaded plugin participate in new requests. |
| **Disable** | Stops invoking the plugin for new requests immediately. |
| **Update** | Fetches and pins the current upstream commit; review it first and restart afterward. |
| **Remove** | Deletes a disabled third-party plugin and its lock entry. Bundled plugins cannot be removed. |

Plugin state and external checkouts live below `MODULES_PATH`, which defaults
to `/data/modules` with the supplied Compose configuration. Back up this path
with the rest of `/data`. Do not edit `modules-lock.json` while MultiVibe is
running.

The bundled **Security** plugin is enabled by default. It provides reversible,
session-scoped pseudonymization before prompt content leaves MultiVibe. It is
maintained in the
[`multivibe-security-module`](https://github.com/thibautrey/multivibe-security-module)
repository and shipped at a pinned submodule commit.

## Admin API

The dashboard uses the authenticated `/admin/modules` API. An admin login
session, `x-admin-token`, or a Bearer admin token is required when
`ADMIN_TOKEN` is configured.

~~~bash
export MULTIVIBE_URL=http://localhost:1455
export ADMIN_TOKEN='replace-with-your-admin-token'

# List plugins
curl -fsS -H "x-admin-token: $ADMIN_TOKEN" \
  "$MULTIVIBE_URL/admin/modules"

# Install and pin a public GitHub repository
curl -fsS -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/owner/repository"}' \
  "$MULTIVIBE_URL/admin/modules/install"

# Enable or disable
curl -fsS -X PATCH -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"enabled":true}' \
  "$MULTIVIBE_URL/admin/modules/com.example.plugin"

# Replace the complete settings object
curl -fsS -X PATCH -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"settings":{"mode":"audit"}}' \
  "$MULTIVIBE_URL/admin/modules/com.example.plugin"

# Fetch and pin the latest upstream commit
curl -fsS -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  "$MULTIVIBE_URL/admin/modules/com.example.plugin/update"

# Disable before removing a third-party plugin
curl -fsS -X PATCH -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"enabled":false}' \
  "$MULTIVIBE_URL/admin/modules/com.example.plugin"
curl -fsS -X DELETE -H "x-admin-token: $ADMIN_TOKEN" \
  "$MULTIVIBE_URL/admin/modules/com.example.plugin"
~~~

Unset the shell variables when finished. Settings updates replace the complete
settings object; they are not a partial merge. MultiVibe validates top-level
property names, primitive types, enums, and numeric bounds from the manifest's
schema.

## Create a plugin

A plugin repository needs a `multivibe.module.json` file at its root and a
prebuilt ECMAScript-module entrypoint. MultiVibe does not install dependencies
or run a build during installation, so commit every runtime file the
entrypoint needs. Avoid dependencies on MultiVibe's private source tree.

~~~text
example-plugin/
├── multivibe.module.json
├── package.json
└── dist/
    └── index.js
~~~

Mark JavaScript files as ECMAScript modules:

~~~json
{
  "type": "module"
}
~~~

Example manifest:

~~~json
{
  "id": "com.example.plugin",
  "name": "Example plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Adds a marker before an upstream request.",
  "entrypoint": "dist/index.js",
  "hooks": ["request.beforeUpstream"],
  "priority": 100,
  "timeoutMs": 5000,
  "failurePolicy": "open",
  "repository": "https://github.com/owner/example-plugin.git",
  "categories": ["Productivity", "Automation"],
  "tags": ["metadata", "routing"],
  "author": "Example Labs",
  "homepage": "https://github.com/owner/example-plugin",
  "settingsSchema": {
    "type": "object",
    "properties": { "marker": { "type": "string" } },
    "additionalProperties": false
  },
  "defaultSettings": { "marker": "example" }
}
~~~

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Stable lowercase identifier, 3–128 characters, using letters, digits, dots, and hyphens. |
| `name`, `version`, `description` | Yes | Operator-facing plugin metadata. |
| `apiVersion` | Yes | Must be `1`. |
| `entrypoint` | Yes | Repository-relative path to a committed ESM JavaScript file. |
| `hooks` | Yes | Hook names the plugin implements. |
| `repository` | Yes | Canonical public GitHub URL; it must match the installation URL after normalization. |
| `categories` | No | Up to 8 category names used for marketplace grouping; uncategorized plugins appear under `Other`. |
| `tags` | No | Up to 16 searchable tags. |
| `author` | No | Author or publisher displayed by marketplace cards. |
| `homepage` | No | Public HTTPS details URL shown on the card. |
| `priority` | No | Execution order; lower values run first, default `100`, then IDs break ties. |
| `timeoutMs` | No | Per-hook timeout, default 5,000 ms and clamped to 10–60,000 ms. |
| `failurePolicy` | No | `open` (default) continues the request after failure; `closed` fails it. |
| `settingsSchema` | No | JSON-Schema-like contract for operator settings. |
| `defaultSettings` | No | Initial settings copied into the lock entry at installation. |

Example entrypoint:

~~~js
export const module = {
  async "request.beforeUpstream"(value, context) {
    context.log.info(`processing ${context.requestId}`);
    return {
      action: "replace",
      value: { ...value, metadata: { ...value.metadata, marker: context.settings.marker } }
    };
  }
};

export default module;
~~~

The entrypoint may export the plugin object as either `default` or `module`.
Each handler receives a structured clone of the current value and a context
object. Return one of:

~~~js
{ action: "continue" }
{ action: "replace", value: replacement }
{ action: "respond", response: { status: 403, headers: {}, body: { error: "blocked" } } }
~~~

`respond` short-circuits the remaining plugins at that hook. Replacements flow
to the next plugin in priority order.

## Hook API v1

| Hook | Current invocation point | Typical use |
| --- | --- | --- |
| `request.received` | After authentication, before routing | Validate, reject, or normalize the client body. |
| `request.beforeUpstream` | After provider/model selection and payload normalization | Redact or adapt the provider-bound payload. |
| `response.received` | On buffered upstream response content | Restore, inspect, or transform upstream data. |
| `response.beforeClient` | Before a buffered Responses object is returned | Apply a final structured transformation or return a custom response. |
| `stream.open` | Reserved in API v1; not currently dispatched | Future stream initialization handling. |
| `request.error` | Reserved in API v1; not currently dispatched | Future error observation or transformation. |

The context can contain:

~~~ts
{
  requestId: string;
  sessionId?: string;
  application?: string;
  route: string;
  transport: "http" | "sse" | "websocket";
  provider?: string;
  model?: string;
  signal: AbortSignal;
  settings: Readonly<Record<string, unknown>>;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}
~~~

Optional fields depend on how far the request has progressed. Do not retain or
mutate the supplied value or settings object. Treat `signal` as the request's
cancellation signal and keep hook work bounded even though MultiVibe also
enforces the manifest timeout.

If a hook throws or times out, MultiVibe marks that plugin unhealthy for the
rest of the process lifetime. With `failurePolicy: "open"`, processing
continues without it. With `"closed"`, the hook failure is propagated; at the
initial request hook this becomes a `500 module_failed` response.

## Release checklist

1. Build the JavaScript entrypoint and commit all runtime artifacts.
2. Test every declared hook with representative request and response shapes.
3. Keep logs free of prompts, responses, credentials, and other secrets.
4. Verify `repository`, `id`, `apiVersion`, timeout, priority, and failure policy.
5. Tag the release, then install or update it from the Plugins page.
6. Confirm the pinned commit and healthy state after restart before enabling it in production.

For the canonical TypeScript contracts and loader behavior, see
[`src/module-sdk.ts`](../src/module-sdk.ts) and
[`src/module-manager.ts`](../src/module-manager.ts).
