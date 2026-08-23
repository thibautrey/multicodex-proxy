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
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
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
      setIsCreateModalOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCreateModal = () => {
    setId("");
    setTargets([]);
    setDescription("");
    setEnabled(true);
    setIsCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (isSubmitting) return;
    setIsCreateModalOpen(false);
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
      <section className="panel alias-routing-panel">
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

      <section className="panel alias-list-panel">
        <div className="section-split-header">
          <div>
            <h2>Model aliases</h2>
            <p className="muted">
              Route a stable model name to an ordered list of fallback targets.
            </p>
          </div>
          <div className="inline wrap alias-list-actions">
            <span className="badge">{aliases.length} aliases</span>
            <button className="btn" onClick={openCreateModal}>
              Create alias
            </button>
          </div>
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
                    No aliases yet. Create one to define your first fallback route.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isCreateModalOpen && (
        <div className="modal-backdrop" onClick={closeCreateModal}>
          <form
            className="modal panel alias-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-alias-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            <div className="modal-title-row">
              <div>
                <h2 id="create-alias-title">Create model alias</h2>
                <p className="muted">
                  Add targets in the order they should be tried. The first available model wins.
                </p>
              </div>
              <button
                type="button"
                className="btn ghost modal-close-button"
                onClick={closeCreateModal}
                disabled={isSubmitting}
                aria-label="Close create alias dialog"
              >
                Close
              </button>
            </div>
            <div className="grid modal-grid alias-modal-grid">
              <label>
                Alias name
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="small or gpt-5.4"
                  autoFocus
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
              <label className="alias-modal-wide">
                Targets (priority order)
                <ModelSelector
                  models={availableModels}
                  value=""
                  onChange={addTarget}
                  disabled={!availableModels.length}
                />
                <span className="field-help">
                  Select one or more models. Add the preferred target first.
                </span>
              </label>
            </div>
            {targets.length > 0 && (
              <div className="alias-preview">
                <span className="muted">Resolved order</span>
                <div className="chips">
                  {targets.map((target, index) => (
                    <span key={target} className="chip">
                      <span className="badge badge-live chip-order">{index + 1}</span>
                      <span className="mono">{target}</span>
                      <button
                        type="button"
                        className="chip-remove"
                        onClick={() => removeTarget(target)}
                        title="Remove target"
                        aria-label={`Remove ${target}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <label className="alias-enabled-control">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>
                <strong>Enabled</strong>
                <small>The alias is immediately available for routing.</small>
              </span>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={closeCreateModal}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn"
                disabled={isSubmitting || !id.trim() || !targets.length}
              >
                {isSubmitting ? "Creating..." : "Create alias"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingAlias && (
        <div className="modal-backdrop" onClick={closeEditModal}>
          <div
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-alias-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="inline wrap row-between">
              <h2 id="edit-alias-title">Update model alias</h2>
              <button className="btn ghost" onClick={closeEditModal}>
                Close
              </button>
            </div>
            <p className="muted">
              Alias names can override an exposed provider model with the same name.
            </p>
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
