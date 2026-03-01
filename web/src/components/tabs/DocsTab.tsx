import React from "react";
import { usd } from "../../lib/ui";

export function DocsTab({ totalTraceCostFromRows }: { totalTraceCostFromRows: number }) {
  return (
    <>
      <section className="panel">
        <h2>API reference</h2>
        <ul className="clean-list">
          <li className="mono">GET /v1/models</li>
          <li className="mono">GET /v1/models/:id</li>
          <li className="mono">POST /v1/chat/completions</li>
          <li className="mono">POST /v1/responses</li>
          <li className="mono">GET /admin/accounts</li>
          <li className="mono">GET /admin/traces?page=1&amp;pageSize=100</li>
          <li className="mono">GET /admin/traces?limit=50 (legacy compatibility)</li>
          <li className="mono">GET /admin/stats/traces?sinceMs=&amp;untilMs=</li>
          <li className="mono">GET /admin/stats/usage?sinceMs=&amp;untilMs=&amp;accountId=&amp;route=</li>
          <li className="mono">POST /admin/oauth/start</li>
          <li className="mono">POST /admin/oauth/complete</li>
        </ul>
        <p className="muted">Admin endpoints require <span className="mono">x-admin-token</span>.</p>
        <p className="muted">Sanitized mode: use URL flag <span className="mono">?sanitized=1</span> or shortcut <span className="mono">Ctrl/Cmd + Shift + S</span>.</p>
      </section>
      <section className="panel">
        <h2>Pricing snapshot</h2>
        <p className="muted">Costs are estimated from input/output tokens using model pricing. UI totals include requests, per-model spend, and global totals.</p>
        <p className="mono">Current page estimated cost: {usd(totalTraceCostFromRows)}</p>
      </section>
    </>
  );
}
