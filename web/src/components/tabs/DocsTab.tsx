import React from "react";
import { usd } from "../../lib/ui";

export function DocsTab({ totalTraceCostFromRows }: { totalTraceCostFromRows: number }) {
  return (
    <>
      <section className="section-header">
        <div>
          <div className="eyebrow">Reference</div>
          <h2>Supported routes and operator notes</h2>
          <p className="muted">
            This should work as a compact control-plane reference, not just a loose list of
            endpoints.
          </p>
        </div>
      </section>

      <section className="grid cards2">
        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Public API</div>
              <h2>OpenAI-compatible surface</h2>
            </div>
            <span className="badge">Client-facing</span>
          </div>
          <ul className="clean-list endpoint-list">
            <li className="mono">GET /v1/models</li>
            <li className="mono">GET /v1/models/:id</li>
            <li className="mono">POST /v1/chat/completions</li>
            <li className="mono">POST /v1/responses</li>
            <li className="mono">POST /v1/responses/compact</li>
          </ul>
        </section>

        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Admin API</div>
              <h2>Operator endpoints</h2>
            </div>
            <span className="badge badge-warn">Requires token</span>
          </div>
          <ul className="clean-list endpoint-list">
            <li className="mono">GET /admin/accounts</li>
            <li className="mono">GET /admin/model-aliases</li>
            <li className="mono">POST /admin/model-aliases</li>
            <li className="mono">PATCH /admin/model-aliases/:id</li>
            <li className="mono">DELETE /admin/model-aliases/:id</li>
            <li className="mono">GET /admin/traces?page=1&amp;pageSize=100</li>
            <li className="mono">GET /admin/traces?limit=50 (legacy compatibility)</li>
            <li className="mono">GET /admin/stats/traces?sinceMs=&amp;untilMs=</li>
            <li className="mono">GET /admin/stats/usage?sinceMs=&amp;untilMs=&amp;accountId=&amp;route=</li>
            <li className="mono">POST /admin/oauth/start</li>
            <li className="mono">POST /admin/oauth/complete</li>
          </ul>
        </section>
      </section>

      <section className="grid cards2">
        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Behavior</div>
              <h2>Operational notes</h2>
            </div>
          </div>
          <ul className="clean-list">
            <li>Admin endpoints require the <span className="mono">x-admin-token</span> header.</li>
            <li>Sanitized mode is enabled with the <span className="mono">?sanitized=1</span> URL flag.</li>
            <li>Trace totals and model spend in the UI are estimates derived from token pricing.</li>
          </ul>
        </section>

        <section className="panel">
          <div className="section-split-header">
            <div>
              <div className="eyebrow">Pricing</div>
              <h2>Current trace page snapshot</h2>
            </div>
            <span className="badge">Derived metric</span>
          </div>
          <p className="muted section-copy">
            Costs are estimated from input and output tokens using model pricing. Use this
            as a dashboard heuristic, not as a billing source of truth.
          </p>
          <p className="mono docs-cost">{usd(totalTraceCostFromRows)}</p>
        </section>
      </section>
    </>
  );
}
