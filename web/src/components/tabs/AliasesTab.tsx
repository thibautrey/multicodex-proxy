import React, { useMemo, useState } from "react";
import type { ModelAlias, ExposedModel, StoreSettings } from "../../types";
import { ModelSelector } from "../ui/ModelSelector";

type EditAliasState = {
  originalId: string;
  id: string;
  targets: string[];
  description: string;
  enabled: boolean;
};

type Props = {
  aliases: ModelAlias[];
  models: ExposedModel[];
  settings: StoreSettings;
  saveAlias: (body: {
    id: string;
    targets: string[];
    enabled?: boolean;
    description?: string;
  }) => Promise<void>;
  patchAlias: (id: string, body: Partial<ModelAlias>) => Promise<void>;
  deleteAlias: (id: string) => Promise<void>;
  patchSettings: (body: Partial<StoreSettings>) => Promise<void>;
};

export function AliasesTab({
  aliases,
  models,
  settings,
  saveAlias,
  patchAlias,
  deleteAlias,
  patchSettings,
}: Props) {
  const [id, setId] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingImageOverride, setIsSavingImageOverride] = useState(false);
  const [editingAlias, setEditingAlias] = useState<EditAliasState | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Model list for selector (exclude current alias id to avoid self-reference)
  const availableModels = useMemo(() => models, [models]);

  const onSubmit = async () => {
    if (!id.trim() || !targets.length) return;
    setIsSubmitting(true);
    try {
      await saveAlias({
        id: id.trim(),
        targets,
        enabled,
        description: description.trim() || undefined,
      });
      setId("");
      setTargets([]);
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
      targets: [...alias.targets],
      description: alias.description ?? "",
      enabled: alias.enabled,
    });
  };

  const saveEditedAlias = async () => {
    if (!editingAlias || !editingAlias.id.trim() || !editingAlias.targets.length) return;
    setIsSavingEdit(true);
    try {
      await patchAlias(editingAlias.originalId, {
        id: editingAlias.id.trim(),
        targets: editingAlias.targets,
        enabled: editingAlias.enabled,
        description: editingAlias.description.trim() || undefined,
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const addTarget = (modelId: string) => {
    if (modelId && !targets.includes(modelId)) {
      setTargets([...targets, modelId]);
    }
  };

  const removeTarget = (modelId: string) => {
    setTargets(targets.filter((t) => t !== modelId));
  };

  const addEditTarget = (modelId: string) => {
    if (editingAlias && modelId && !editingAlias.targets.includes(modelId)) {
      setEditingAlias({ ...editingAlias, targets: [...editingAlias.targets, modelId] });
    }
  };

  const removeEditTarget = (modelId: string) => {
    if (editingAlias) {
      setEditingAlias({ ...editingAlias, targets: editingAlias.targets.filter((t) => t !== modelId) });
    }
  };

  const saveImageOverride = async (modelId: string | undefined) => {
    setIsSavingImageOverride(true);
    try {
      await patchSettings({ imageRequestModelOverride: modelId });
    } finally {
      setIsSavingImageOverride(false);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>Image request model</h2>
            <p className="muted">
              Requests containing images are routed to this model for that request only.
            </p>
          </div>
          <span className="badge">
            {settings.imageRequestModelOverride ? "Enabled" : "Default routing"}
          </span>
        </div>
        <div className="grid alias-grid">
          <label>
            Override model
            <ModelSelector
              models={availableModels}
              value={settings.imageRequestModelOverride ?? ""}
              onChange={(modelId) => void saveImageOverride(modelId)}
              disabled={!availableModels.length || isSavingImageOverride}
            />
          </label>
          <label className="inline">
            <button
              className="btn ghost"
              disabled={!settings.imageRequestModelOverride || isSavingImageOverride}
              onClick={() => void saveImageOverride(undefined)}
            >
              Clear override
            </button>
          </label>
        </div>
      </section>

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
              <ModelSelector
                models={availableModels}
                value=""
                onChange={addTarget}
                disabled={!availableModels.length}
              />
              <span className="muted" style={{fontSize: "0.8rem"}}>
                Select models in priority order. You can also type to filter.
              </span>
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
          {targets.length > 0 && (
            <div className="alias-preview">
              <span className="muted">Resolved order</span>
              <div className="chips">
                {targets.map((target, index) => (
                  <span key={target} className="chip">
                    <span className="badge badge-live" style={{marginRight: 4}}>{index + 1}</span>
                    <span className="mono">{target}</span>
                    <button
                      className="chip-remove"
                      onClick={() => removeTarget(target)}
                      title="Remove target"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="inline wrap">
            <button
              className="btn"
              disabled={isSubmitting || !id.trim() || !targets.length}
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
                <ModelSelector
                  models={availableModels}
                  value=""
                  onChange={addEditTarget}
                  disabled={!availableModels.length}
                />
                <span className="muted" style={{fontSize: "0.8rem"}}>
                  Select models in priority order.
                </span>
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
            {editingAlias.targets.length > 0 && (
              <div className="alias-preview">
                <span className="muted">Resolved order</span>
                <div className="chips">
                  {editingAlias.targets.map((target, index) => (
                    <span key={target} className="chip">
                      <span className="badge badge-live" style={{marginRight: 4}}>{index + 1}</span>
                      <span className="mono">{target}</span>
                      <button
                        className="chip-remove"
                        onClick={() => removeEditTarget(target)}
                        title="Remove target"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="inline wrap">
              <button
                className="btn"
                disabled={isSavingEdit || !editingAlias.id.trim() || !editingAlias.targets.length}
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
