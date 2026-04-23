import React, { useMemo, useState } from "react";
import type { ModelAlias } from "../../types";

type EditAliasState = {
  originalId: string;
  id: string;
  targets: string;
  description: string;
  enabled: boolean;
};

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
  const [editingAlias, setEditingAlias] = useState<EditAliasState | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

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

  const parsedEditTargets = useMemo(
    () =>
      Array.from(
        new Set(
          (editingAlias?.targets ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ),
    [editingAlias?.targets],
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

  const closeEditModal = () => {
    setEditingAlias(null);
    setIsSavingEdit(false);
  };

  const openEditModal = (alias: ModelAlias) => {
    setEditingAlias({
      originalId: alias.id,
      id: alias.id,
      targets: alias.targets.join(", "),
      description: alias.description ?? "",
      enabled: alias.enabled,
    });
  };

  const saveEditedAlias = async () => {
    if (!editingAlias || !editingAlias.id.trim() || !parsedEditTargets.length) return;
    setIsSavingEdit(true);
    try {
      await patchAlias(editingAlias.originalId, {
        id: editingAlias.id.trim(),
        targets: parsedEditTargets,
        enabled: editingAlias.enabled,
        description: editingAlias.description.trim() || undefined,
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
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
                      onClick={() => openEditModal(a)}
                    >
                      Edit
                    </button>
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

      {editingAlias && (
        <div className="modal-backdrop" onClick={closeEditModal}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>Update model alias</h2>
              <button className="btn ghost" onClick={closeEditModal}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Alias name
                <input
                  value={editingAlias.id}
                  onChange={(e) =>
                    setEditingAlias((current) =>
                      current ? { ...current, id: e.target.value } : current,
                    )
                  }
                  placeholder="small or gpt-5.4"
                />
              </label>
              <label>
                Targets (priority order)
                <input
                  value={editingAlias.targets}
                  onChange={(e) =>
                    setEditingAlias((current) =>
                      current ? { ...current, targets: e.target.value } : current,
                    )
                  }
                  placeholder="gpt-5.1-codex-mini,devstral-small-latest"
                />
              </label>
              <label>
                Description (optional)
                <input
                  value={editingAlias.description}
                  onChange={(e) =>
                    setEditingAlias((current) =>
                      current ? { ...current, description: e.target.value } : current,
                    )
                  }
                  placeholder="Small, low-cost coding model"
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={editingAlias.enabled}
                  onChange={(e) =>
                    setEditingAlias((current) =>
                      current ? { ...current, enabled: e.target.checked } : current,
                    )
                  }
                />
                Enabled
              </label>
            </div>
            {parsedEditTargets.length > 0 && (
              <div className="alias-preview">
                <span className="muted">Resolved order</span>
                <div className="chips">
                  {parsedEditTargets.map((target) => (
                    <span key={target} className="chip mono">{target}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="inline wrap">
              <button
                className="btn"
                disabled={isSavingEdit || !editingAlias.id.trim() || !parsedEditTargets.length}
                onClick={() => void saveEditedAlias()}
              >
                {isSavingEdit ? "Saving..." : "Save changes"}
              </button>
              <button className="btn ghost" onClick={closeEditModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
