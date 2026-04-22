import React, { useMemo, useState } from "react";
import type { ModelAlias } from "../../types";

type Props = {
  aliases: ModelAlias[];
  saveAlias: (body: {
    id: string;
    targets: string[];
    enabled?: boolean;
    description?: string;
  }) => Promise<void>;
  patchAlias: (id: string, body: Partial<ModelAlias>) => Promise<void>;
  deleteAlias: (id: string) => Promise<void>;
};

export function AliasesTab({
  aliases,
  saveAlias,
  patchAlias,
  deleteAlias,
}: Props) {
  const [id, setId] = useState("");
  const [targets, setTargets] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const parsedTargets = useMemo(
    () =>
      Array.from(
        new Set(
          targets
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ),
    [targets],
  );

  const onSubmit = async () => {
    if (!id.trim() || !parsedTargets.length) return;
    setIsSubmitting(true);
    try {
      await saveAlias({
        id: id.trim(),
        targets: parsedTargets,
        enabled,
        description: description.trim() || undefined,
      });
      setId("");
      setTargets("");
      setDescription("");
      setEnabled(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="section-split-header">
          <h2>Create model alias</h2>
          <span className="badge">{aliases.length} aliases</span>
        </div>
          <p className="muted">
            Alias names can reuse an already exposed model name. If they do, the alias overrides
            the provider model and routes requests to the configured targets instead.
          </p>
          <div className="grid alias-grid">
            <label>
              Alias name
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="small or gpt-5.4"
              />
            </label>
            <label>
              Targets (priority order)
              <input
                value={targets}
                onChange={(e) => setTargets(e.target.value)}
                placeholder="gpt-5.1-codex-mini,devstral-small-latest"
              />
            </label>
            <label>
              Description (optional)
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Small, low-cost coding model"
              />
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
          </div>
          {parsedTargets.length > 0 && (
            <div className="alias-preview">
              <span className="muted">Resolved order</span>
              <div className="chips">
                {parsedTargets.map((target) => (
                  <span key={target} className="chip mono">{target}</span>
                ))}
              </div>
            </div>
          )}
          <div className="inline wrap">
            <button
              className="btn"
              disabled={isSubmitting || !id.trim() || !parsedTargets.length}
              onClick={() => void onSubmit()}
            >
              {isSubmitting ? "Saving..." : "Create alias"}
            </button>
          </div>
      </section>

      <section className="panel">
        <div className="section-split-header">
          <h2>Aliases</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Targets</th>
                <th>Description</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.id}</td>
                  <td className="mono">{a.targets.join(", ")}</td>
                  <td>{a.description ?? "-"}</td>
                  <td>
                    <span className={a.enabled ? "badge badge-live" : "badge badge-warn"}>
                      {a.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td className="inline wrap">
                    <button
                      className="btn ghost"
                      onClick={() =>
                        void patchAlias(a.id, { enabled: !a.enabled })
                      }
                    >
                      {a.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => void deleteAlias(a.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!aliases.length && (
                <tr>
                  <td colSpan={5} className="muted empty-row">
                    No aliases yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
