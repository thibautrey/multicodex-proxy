import React, { useEffect, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "../../lib/clipboard";
import type { ExposedModel } from "../../types";
import {
  ENDPOINTS,
  GROUPS,
  type ApiEndpoint,
  type EndpointGroup,
  type HttpMethod,
} from "./docsCatalog";
import "./DocsTab.css";

type RequestResult = {
  status: number | null;
  statusText: string;
  durationMs?: number;
  body: string;
  contentType?: string;
  error?: boolean;
};

type Props = {
  models: ExposedModel[];
  initialEndpointId?: string;
  initialModel?: string;
};

type IconName =
  | "search"
  | "copy"
  | "send"
  | "check"
  | "terminal"
  | "lock"
  | "chevron"
  | "stop";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    terminal: (
      <>
        <path d="m4 17 6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function hydrateExample(value: string | undefined, model: string) {
  return (value ?? "")
    .split("{{model}}")
    .join(model || "gpt-5.3-codex");
}

function methodClass(method: HttpMethod) {
  return "docs-method docs-method-" + method.toLowerCase();
}

function tryFormatJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function shellQuote(value: string) {
  return "'" + value.split("'").join("'" + '"' + "'" + '"' + "'") + "'";
}

export function DocsTab({ models, initialEndpointId, initialModel }: Props) {
  const linkedModel = initialModel?.trim();
  const defaultModel =
    linkedModel &&
    (!models.length || models.some((model) => model.id === linkedModel))
      ? linkedModel
      : models[0]?.id || "gpt-5.3-codex";
  const linkedEndpointId =
    ENDPOINTS.find((endpoint) => endpoint.id === initialEndpointId)?.id ??
    ENDPOINTS[0].id;
  const [selectedId, setSelectedId] = useState(linkedEndpointId);
  const [search, setSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState<EndpointGroup | "All">("All");
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [requestBody, setRequestBody] = useState("");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected =
    ENDPOINTS.find((endpoint) => endpoint.id === selectedId) ?? ENDPOINTS[0];
  const origin = window.location.origin;

  const filteredEndpoints = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return ENDPOINTS.filter((endpoint) => {
      if (activeGroup !== "All" && endpoint.group !== activeGroup) return false;
      if (!needle) return true;
      return [
        endpoint.method,
        endpoint.path,
        endpoint.title,
        endpoint.summary,
        endpoint.group,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [activeGroup, search]);

  useEffect(() => {
    setSelectedId(linkedEndpointId);
  }, [linkedEndpointId]);

  useEffect(() => {
    setPathValues(
      Object.fromEntries(
        (selected.pathParams ?? []).map((field) => [
          field.name,
          hydrateExample(field.example, defaultModel),
        ]),
      ),
    );
    setQueryValues(
      Object.fromEntries(
        (selected.queryParams ?? []).map((field) => [
          field.name,
          hydrateExample(field.example, defaultModel),
        ]),
      ),
    );
    setRequestBody(hydrateExample(selected.requestBody, defaultModel));
    setResult(null);
  }, [defaultModel, selected.id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function resolvedPath() {
    const pathname = (selected.pathParams ?? []).reduce(
      (value, field) =>
        value.replace(
          ":" + field.name,
          encodeURIComponent(pathValues[field.name]?.trim() ?? ""),
        ),
      selected.path,
    );
    const params = new URLSearchParams();
    for (const field of selected.queryParams ?? []) {
      const value = queryValues[field.name]?.trim();
      if (value) params.set(field.name, value);
    }
    const query = params.toString();
    return query ? pathname + "?" + query : pathname;
  }

  function curlSnippet() {
    const body = requestBody.trim();
    const lines = [
      "curl --request " +
        selected.method +
        " " +
        shellQuote(origin + resolvedPath()),
    ];
    lines.push(
      selected.path.startsWith("/admin/")
        ? "  --header 'x-admin-token: $ADMIN_TOKEN'"
        : "  --header 'Authorization: Bearer $PROXY_API_KEY'",
    );
    if (body && selected.method !== "GET") {
      lines.push("  --header 'content-type: application/json'");
      lines.push("  --data " + shellQuote(body));
    }
    return lines.join(" " + String.fromCharCode(92) + "\n");
  }

  async function copy(value: string, key: string) {
    await copyTextToClipboard(value);
    setCopied(key);
    window.setTimeout(
      () => setCopied((current) => (current === key ? null : current)),
      1600,
    );
  }

  function selectEndpoint(endpoint: ApiEndpoint) {
    abortRef.current?.abort();
    setRunning(false);
    setSelectedId(endpoint.id);
    if (window.innerWidth < 1120) {
      window.requestAnimationFrame(() => {
        document
          .querySelector(".docs-reference")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  async function runRequest() {
    const missingPathField = (selected.pathParams ?? []).find(
      (field) => field.required && !pathValues[field.name]?.trim(),
    );
    if (missingPathField) {
      setResult({
        status: null,
        statusText: "Request not sent",
        body: missingPathField.name + " is required.",
        error: true,
      });
      return;
    }

    let body: string | undefined;
    if (requestBody.trim() && selected.method !== "GET") {
      try {
        body = JSON.stringify(JSON.parse(requestBody));
      } catch (error: any) {
        setResult({
          status: null,
          statusText: "Invalid JSON",
          body: error?.message ?? String(error),
          error: true,
        });
        return;
      }
    }

    if (
      selected.destructive &&
      !window.confirm(
        "Send " +
          selected.method +
          " " +
          resolvedPath() +
          "? This request changes server state.",
      )
    ) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    const startedAt = performance.now();

    try {
      const response = await fetch(resolvedPath(), {
        method: selected.method,
        credentials: "same-origin",
        headers: body
          ? { "content-type": "application/json", accept: "application/json" }
          : { accept: "application/json" },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      setResult({
        status: response.status,
        statusText:
          response.statusText ||
          (response.ok ? "Success" : "Request failed"),
        durationMs: Math.round(performance.now() - startedAt),
        body: raw ? tryFormatJson(raw) : "No response body.",
        contentType: response.headers.get("content-type") ?? undefined,
        error: !response.ok,
      });
    } catch (error: any) {
      const aborted = error?.name === "AbortError";
      setResult({
        status: null,
        statusText: aborted ? "Cancelled" : "Network error",
        durationMs: Math.round(performance.now() - startedAt),
        body: aborted
          ? "The request was cancelled."
          : (error?.message ?? String(error)),
        error: !aborted,
      });
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const fields = [
    ...(selected.pathParams ?? []),
    ...(selected.queryParams ?? []),
  ];

  return (
    <div className="docs-page">
      <section className="docs-hero">
        <div className="docs-base-url-card">
          <div>
            <span className="control-label">Base URL</span>
            <small>Use this origin for every endpoint below.</small>
          </div>
          <div className="docs-copy-row">
            <code>{origin}</code>
            <button
              className="docs-icon-button"
              onClick={() => void copy(origin, "origin")}
              aria-label="Copy base URL"
              title="Copy base URL"
            >
              <Icon name={copied === "origin" ? "check" : "copy"} />
            </button>
          </div>
          <div className="docs-session-note">
            <span className="status-dot" />
            <span>
              <strong>Ready to test</strong>
              <small>
                Your signed-in dashboard session is used automatically.
              </small>
            </span>
          </div>
        </div>
      </section>

      <section className="docs-shell">
        <aside className="docs-catalog" aria-label="API endpoint catalog">
          <div className="docs-search">
            <Icon name="search" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search endpoints"
              aria-label="Search API endpoints"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear endpoint search"
              >
                ×
              </button>
            )}
          </div>

          <div className="docs-group-tabs" aria-label="Filter endpoint groups">
            {(["All", ...GROUPS] as const).map((group) => (
              <button
                key={group}
                className={activeGroup === group ? "active" : ""}
                onClick={() => setActiveGroup(group)}
              >
                {group}
                <span>
                  {group === "All"
                    ? ENDPOINTS.length
                    : ENDPOINTS.filter(
                        (endpoint) => endpoint.group === group,
                      ).length}
                </span>
              </button>
            ))}
          </div>

          <div className="docs-endpoint-list">
            {GROUPS.map((group) => {
              const endpoints = filteredEndpoints.filter(
                (endpoint) => endpoint.group === group,
              );
              if (!endpoints.length) return null;
              return (
                <section key={group}>
                  <h3>{group}</h3>
                  {endpoints.map((endpoint) => (
                    <button
                      key={endpoint.id}
                      className={selected.id === endpoint.id ? "active" : ""}
                      onClick={() => selectEndpoint(endpoint)}
                    >
                      <span className={methodClass(endpoint.method)}>
                        {endpoint.method}
                      </span>
                      <span>
                        <strong>{endpoint.title}</strong>
                        <code>{endpoint.path}</code>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </section>
              );
            })}
            {!filteredEndpoints.length && (
              <div className="docs-empty-search">
                <strong>No endpoint found</strong>
                <small>Try a path, method or broader keyword.</small>
              </div>
            )}
          </div>
        </aside>

        <article className="docs-reference">
          <header className="docs-endpoint-header">
            <div className="docs-endpoint-route">
              <span className={methodClass(selected.method)}>
                {selected.method}
              </span>
              <code>{selected.path}</code>
            </div>
            <span className="docs-endpoint-group">{selected.group}</span>
            <h2>{selected.title}</h2>
            <p>{selected.description}</p>
          </header>

          <div className="docs-reference-grid">
            <section className="docs-reference-content">
              <div className="docs-section">
                <div className="docs-section-heading">
                  <div>
                    <span>Overview</span>
                    <h3>{selected.summary}</h3>
                  </div>
                </div>
                <div className="docs-auth-callout">
                  <Icon name="lock" />
                  <div>
                    <strong>
                      {selected.path.startsWith("/admin/")
                        ? "Admin authentication"
                        : "Application authentication"}
                    </strong>
                    <p>
                      The interactive console uses your secure dashboard
                      session. External clients should send
                      {selected.path.startsWith("/admin/")
                        ? " x-admin-token or a Bearer admin token."
                        : " a proxy API key as Bearer or x-api-key."}
                    </p>
                  </div>
                </div>
              </div>

              {!!fields.length && (
                <div className="docs-section">
                  <div className="docs-section-heading">
                    <div>
                      <span>Reference</span>
                      <h3>Parameters</h3>
                    </div>
                  </div>
                  <div className="docs-parameter-table">
                    {fields.map((field) => (
                      <div key={field.name + "-" + field.description}>
                        <code>{field.name}</code>
                        <span>{field.type}</span>
                        <span
                          className={field.required ? "required" : "optional"}
                        >
                          {field.required ? "Required" : "Optional"}
                        </span>
                        <p>{field.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.note && (
                <div className="docs-note">
                  <strong>Good to know</strong>
                  <p>{selected.note}</p>
                </div>
              )}

              <div className="docs-section">
                <div className="docs-section-heading">
                  <div>
                    <span>Example</span>
                    <h3>Response</h3>
                  </div>
                  <button
                    className="docs-copy-button"
                    onClick={() =>
                      void copy(
                        hydrateExample(
                          selected.responseExample,
                          defaultModel,
                        ),
                        "response",
                      )
                    }
                  >
                    <Icon
                      name={copied === "response" ? "check" : "copy"}
                    />
                    {copied === "response" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="docs-code">
                  <code>
                    {hydrateExample(selected.responseExample, defaultModel)}
                  </code>
                </pre>
              </div>
            </section>

            <aside className="docs-console">
              <div className="docs-console-header">
                <div>
                  <Icon name="terminal" />
                  <span>
                    <strong>Try it</strong>
                    <small>Live request</small>
                  </span>
                </div>
                <span className="docs-live-pill">
                  <span className="status-dot" /> Connected
                </span>
              </div>

              <div className="docs-request-url">
                <span className={methodClass(selected.method)}>
                  {selected.method}
                </span>
                <code>{resolvedPath()}</code>
              </div>

              {!!selected.pathParams?.length && (
                <div className="docs-console-section">
                  <span className="control-label">Path parameters</span>
                  <div className="docs-field-grid">
                    {selected.pathParams.map((field) => (
                      <label key={field.name}>
                        <span>
                          <code>{field.name}</code>
                          {field.required && <b>Required</b>}
                        </span>
                        <input
                          value={pathValues[field.name] ?? ""}
                          onChange={(event) =>
                            setPathValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                          placeholder={hydrateExample(
                            field.example,
                            defaultModel,
                          )}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!!selected.queryParams?.length && (
                <div className="docs-console-section">
                  <span className="control-label">Query parameters</span>
                  <div className="docs-field-grid">
                    {selected.queryParams.map((field) => (
                      <label key={field.name}>
                        <span>
                          <code>{field.name}</code>
                          {field.required && <b>Required</b>}
                        </span>
                        <input
                          value={queryValues[field.name] ?? ""}
                          onChange={(event) =>
                            setQueryValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                          placeholder={
                            hydrateExample(field.example, defaultModel) ||
                            "Optional"
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {selected.requestBody !== undefined && (
                <div className="docs-console-section">
                  <div className="docs-console-label">
                    <span className="control-label">JSON body</span>
                    <span>application/json</span>
                  </div>
                  <textarea
                    className="docs-json-editor mono"
                    value={requestBody}
                    onChange={(event) => setRequestBody(event.target.value)}
                    rows={12}
                    spellCheck={false}
                    aria-label="JSON request body"
                  />
                </div>
              )}

              <div className="docs-console-actions">
                {running ? (
                  <button
                    className="btn danger"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Icon name="stop" /> Cancel request
                  </button>
                ) : (
                  <button
                    className={selected.destructive ? "btn danger" : "btn"}
                    onClick={() => void runRequest()}
                  >
                    <Icon name="send" /> Send request
                  </button>
                )}
                <small>
                  Credentials are never added to the editor or response.
                </small>
              </div>

              <div className="docs-curl-block">
                <div className="docs-console-label">
                  <span className="control-label">cURL</span>
                  <button
                    onClick={() => void copy(curlSnippet(), "curl")}
                  >
                    <Icon name={copied === "curl" ? "check" : "copy"} />
                    {copied === "curl" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre>
                  <code>{curlSnippet()}</code>
                </pre>
              </div>

              <div
                className={
                  "docs-response " + (result?.error ? "is-error" : "")
                }
                aria-live="polite"
              >
                <div className="docs-response-header">
                  <div>
                    <span className="control-label">Response</span>
                    {running && <span className="docs-running-dot" />}
                  </div>
                  {result && (
                    <div className="docs-response-meta">
                      <span
                        className={
                          result.error
                            ? "error"
                            : result.status && result.status < 400
                              ? "success"
                              : "neutral"
                        }
                      >
                        {result.status
                          ? result.status + " " + result.statusText
                          : result.statusText}
                      </span>
                      {result.durationMs !== undefined && (
                        <span>{result.durationMs} ms</span>
                      )}
                    </div>
                  )}
                </div>
                <pre>
                  <code>
                    {running
                      ? "Sending request…"
                      : (result?.body ??
                        "Run the request to inspect its response here.")}
                  </code>
                </pre>
                {result?.contentType && <small>{result.contentType}</small>}
              </div>
            </aside>
          </div>
        </article>
      </section>
    </div>
  );
}
