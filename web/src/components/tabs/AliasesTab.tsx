import React, { useMemo, useState } from "react";
import type {
  ExposedModel,
  ModelAlias,
  PriorityClass,
  RoutingCandidate,
  RoutingRule,
  StoreSettings,
} from "../../types";
import { ModelSelector } from "../ui/ModelSelector";

const PRIORITIES: PriorityClass[] = ["critical", "interactive", "standard", "batch"];
const blankRule = (): RoutingRule => ({
  id: "default",
  candidates: [],
  objectives: { latency: 25, cost: 20, quality: 30, locality: 25 },
  onNoCapacity: "queue",
});
const blankAlias = (): ModelAlias => ({
  schemaVersion: 2,
  id: "",
  enabled: true,
  description: "",
  rules: [blankRule()],
});

type Props = {
  aliases: ModelAlias[];
  models: ExposedModel[];
  settings: StoreSettings;
  saveAlias: (body: ModelAlias) => Promise<void>;
  patchAlias: (id: string, body: Partial<ModelAlias>) => Promise<void>;
  deleteAlias: (id: string) => Promise<void>;
  patchSettings: (body: Partial<StoreSettings>) => Promise<void>;
  simulateAlias: (alias: ModelAlias, request: Record<string, unknown>) => Promise<any>;
  loadCapacity: (model: string, priority: PriorityClass) => Promise<any>;
};

function uniqueModels(alias: ModelAlias) {
  return Array.from(new Set(alias.rules.flatMap((rule) => rule.candidates.map((candidate) => candidate.model))));
}

export function AliasesTab({
  aliases,
  models,
  settings,
  saveAlias,
  patchAlias,
  deleteAlias,
  patchSettings,
  simulateAlias,
  loadCapacity,
}: Props) {
  const [draft, setDraft] = useState<ModelAlias>(() => blankAlias());
  const [originalId, setOriginalId] = useState<string>();
  const [editorMode, setEditorMode] = useState<"visual" | "json">("visual");
  const [jsonDraft, setJsonDraft] = useState(JSON.stringify(blankAlias(), null, 2));
  const [jsonError, setJsonError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [simulation, setSimulation] = useState<any>();
  const [simulationRequest, setSimulationRequest] = useState({
    application: "simulation",
    priority: "standard" as PriorityClass,
    effort: "medium",
    inputTokens: 2_000,
    requiresTools: false,
  });
  const [capacity, setCapacity] = useState<any>();
  const [capacityPriority, setCapacityPriority] = useState<PriorityClass>("interactive");
  const availableModels = useMemo(() => models, [models]);

  const selectDraft = (alias?: ModelAlias) => {
    const next = alias ? structuredClone(alias) : blankAlias();
    setDraft(next);
    setOriginalId(alias?.id);
    setJsonDraft(JSON.stringify(next, null, 2));
    setJsonError(undefined);
    setSimulation(undefined);
    setCapacity(undefined);
  };

  const updateRule = (index: number, update: (rule: RoutingRule) => RoutingRule) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule, ruleIndex) => (ruleIndex === index ? update(rule) : rule)),
    }));
  };

  const addCandidate = (ruleIndex: number, model: string) => {
    if (!model) return;
    updateRule(ruleIndex, (rule) =>
      rule.candidates.some((candidate) => candidate.model === model)
        ? rule
        : { ...rule, candidates: [...rule.candidates, { model, quality: 50 }] },
    );
  };

  const updateCandidate = (
    ruleIndex: number,
    candidateIndex: number,
    patch: Partial<RoutingCandidate>,
  ) => updateRule(ruleIndex, (rule) => ({
    ...rule,
    candidates: rule.candidates.map((candidate, index) =>
      index === candidateIndex ? { ...candidate, ...patch } : candidate,
    ),
  }));

  const moveRule = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draft.rules.length) return;
    const rules = [...draft.rules];
    [rules[index], rules[nextIndex]] = [rules[nextIndex], rules[index]];
    setDraft({ ...draft, rules });
  };

  const moveCandidate = (ruleIndex: number, index: number, offset: number) => {
    updateRule(ruleIndex, (rule) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= rule.candidates.length) return rule;
      const candidates = [...rule.candidates];
      [candidates[index], candidates[nextIndex]] = [candidates[nextIndex], candidates[index]];
      return { ...rule, candidates };
    });
  };

  const switchMode = (mode: "visual" | "json") => {
    if (mode === "json") setJsonDraft(JSON.stringify(draft, null, 2));
    setEditorMode(mode);
  };

  const parseJson = (value: string) => {
    setJsonDraft(value);
    try {
      const parsed = JSON.parse(value) as ModelAlias;
      if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.rules)) {
        throw new Error("schemaVersion 2 and rules[] are required");
      }
      setDraft(parsed);
      setJsonError(undefined);
    } catch (error: any) {
      setJsonError(error?.message ?? String(error));
    }
  };

  const save = async () => {
    if (!draft.id.trim() || !draft.rules.length || draft.rules.some((rule) => !rule.candidates.length)) return;
    setSaving(true);
    try {
      const normalized = { ...draft, id: draft.id.trim() };
      if (originalId) await patchAlias(originalId, normalized);
      else await saveAlias(normalized);
      selectDraft();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="panel alias-routing-panel">
        <div className="section-split-header">
          <div>
            <h2>Smart routing policies</h2>
            <p className="muted">Versioned rules choose local or cloud capacity and decide whether work is queued.</p>
          </div>
          <button className="btn" onClick={() => selectDraft()}>New policy</button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Alias</th><th>Rules</th><th>Candidates</th><th>Status</th><th /></tr></thead>
            <tbody>
              {aliases.map((alias) => (
                <tr key={alias.id}>
                  <td><span className="mono">{alias.id}</span><div className="muted">{alias.description}</div></td>
                  <td>{alias.rules.length}</td>
                  <td className="mono">{uniqueModels(alias).join(", ")}</td>
                  <td><span className={alias.enabled ? "badge badge-live" : "badge badge-warn"}>{alias.enabled ? "Enabled" : "Disabled"}</span></td>
                  <td className="inline wrap">
                    <button className="btn ghost" onClick={() => selectDraft(alias)}>Edit</button>
                    <button className="btn ghost" onClick={() => void patchAlias(alias.id, { enabled: !alias.enabled })}>{alias.enabled ? "Disable" : "Enable"}</button>
                    <button className="btn danger" onClick={() => void deleteAlias(alias.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!aliases.length && <tr><td colSpan={5} className="muted empty-row">No policy yet. Create one for the future local Mac or a cloud fallback.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel smart-alias-editor">
        <div className="section-split-header">
          <div><h2>{originalId ? `Edit ${originalId}` : "Policy builder"}</h2><p className="muted">Rules are evaluated top to bottom; candidate order breaks score ties.</p></div>
          <div className="inline wrap">
            <button className={`btn ${editorMode === "visual" ? "" : "ghost"}`} onClick={() => switchMode("visual")}>Visual</button>
            <button className={`btn ${editorMode === "json" ? "" : "ghost"}`} onClick={() => switchMode("json")}>JSON</button>
          </div>
        </div>

        {editorMode === "json" ? (
          <label>Validated schema v2 JSON
            <textarea className="smart-json-editor mono" value={jsonDraft} onChange={(event) => parseJson(event.target.value)} />
            {jsonError && <span className="field-error">{jsonError}</span>}
          </label>
        ) : (
          <>
            <div className="grid smart-alias-basics">
              <label>Alias<input value={draft.id} disabled={Boolean(originalId)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="smart-code" /></label>
              <label>Description<input value={draft.description ?? ""} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <label>Default priority<select value={draft.defaults?.priority ?? ""} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, priority: (event.target.value || undefined) as PriorityClass | undefined } })}><option value="">Legacy sync default</option>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
              <label className="inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />Enabled</label>
            </div>

            {draft.rules.map((rule, ruleIndex) => (
              <div className="smart-rule" key={`${rule.id}-${ruleIndex}`}>
                <div className="section-split-header">
                  <h3>Rule {ruleIndex + 1}</h3>
                  <div className="inline wrap"><button className="btn ghost" disabled={ruleIndex === 0} onClick={() => moveRule(ruleIndex, -1)}>↑</button><button className="btn ghost" disabled={ruleIndex === draft.rules.length - 1} onClick={() => moveRule(ruleIndex, 1)}>↓</button><button className="btn danger" disabled={draft.rules.length === 1} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, index) => index !== ruleIndex) })}>Remove</button></div>
                </div>
                <div className="grid smart-rule-grid">
                  <label>Rule id<input value={rule.id} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, id: event.target.value }))} /></label>
                  <label>Applications (comma-separated)<input value={rule.match?.applications?.join(", ") ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, applications: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } }))} /></label>
                  <label>Reasoning efforts<input value={rule.match?.efforts?.join(", ") ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, efforts: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } }))} placeholder="low, medium, high" /></label>
                  <label>Priorities<select multiple value={rule.match?.priorities ?? []} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, priorities: Array.from(event.target.selectedOptions).map((option) => option.value as PriorityClass) } }))}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
                  <label>Execution modes<select multiple value={rule.match?.executionModes ?? []} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, executionModes: Array.from(event.target.selectedOptions).map((option) => option.value as "sync" | "auto" | "defer") } }))}><option>sync</option><option>auto</option><option>defer</option></select></label>
                  <label>Modalities<select multiple value={rule.match?.modalities ?? []} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, modalities: Array.from(event.target.selectedOptions).map((option) => option.value as "text" | "image" | "audio" | "video") } }))}><option>text</option><option>image</option><option>audio</option><option>video</option></select></label>
                  <label>Tools<select value={rule.match?.requiresTools === undefined ? "any" : rule.match.requiresTools ? "required" : "forbidden"} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, requiresTools: event.target.value === "any" ? undefined : event.target.value === "required" } }))}><option value="any">Any</option><option value="required">Required</option><option value="forbidden">Forbidden</option></select></label>
                  <label>Minimum input tokens<input type="number" min="0" value={rule.match?.minInputTokens ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, minInputTokens: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
                  <label>Maximum input tokens<input type="number" min="0" value={rule.match?.maxInputTokens ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, maxInputTokens: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
                  <label>Time window start<input type="time" value={rule.match?.timeWindows?.[0]?.start ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, timeWindows: event.target.value ? [{ start: event.target.value, end: current.match?.timeWindows?.[0]?.end ?? "07:00", timezone: current.match?.timeWindows?.[0]?.timezone ?? "Europe/Paris" }] : undefined } }))} /></label>
                  <label>Time window end<input type="time" value={rule.match?.timeWindows?.[0]?.end ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, timeWindows: event.target.value ? [{ start: current.match?.timeWindows?.[0]?.start ?? "22:00", end: event.target.value, timezone: current.match?.timeWindows?.[0]?.timezone ?? "Europe/Paris" }] : undefined } }))} /></label>
                  <label>Timezone<input value={rule.match?.timeWindows?.[0]?.timezone ?? "Europe/Paris"} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, timeWindows: current.match?.timeWindows?.[0] ? [{ ...current.match.timeWindows[0], timezone: event.target.value }] : undefined } }))} /></label>
                  <label>Days (0 Sunday–6 Saturday)<input value={rule.match?.timeWindows?.[0]?.days?.join(", ") ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, timeWindows: current.match?.timeWindows?.[0] ? [{ ...current.match.timeWindows[0], days: event.target.value.split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6) }] : undefined } }))} /></label>
                  <label>Allowed locations<select multiple value={rule.constraints?.allowedLocations ?? []} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, constraints: { ...current.constraints, allowedLocations: Array.from(event.target.selectedOptions).map((option) => option.value as "local" | "cloud") } }))}><option>local</option><option>cloud</option></select></label>
                  <label>Max predicted wait (ms)<input type="number" value={rule.constraints?.maxPredictedWaitMs ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, constraints: { ...current.constraints, maxPredictedWaitMs: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
                  <label>Minimum context<input type="number" min="0" value={rule.constraints?.minContextWindow ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, constraints: { ...current.constraints, minContextWindow: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
                  <label>Minimum quality<input type="number" min="0" max="100" value={rule.constraints?.minQuality ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, constraints: { ...current.constraints, minQuality: event.target.value ? Number(event.target.value) : undefined } }))} /></label>
                  <label>No capacity<select value={rule.onNoCapacity ?? "reject"} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, onNoCapacity: event.target.value as RoutingRule["onNoCapacity"] }))}><option value="next-rule">Next rule</option><option value="queue">Queue</option><option value="reject">Reject</option></select></label>
                  <label>Cloud budget USD<input type="number" min="0" step="0.01" value={rule.cloudBudget?.amountUsd ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, cloudBudget: event.target.value ? { amountUsd: Number(event.target.value), period: current.cloudBudget?.period ?? "month" } : undefined }))} /></label>
                  <label>Budget period<select value={rule.cloudBudget?.period ?? "month"} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, cloudBudget: current.cloudBudget ? { ...current.cloudBudget, period: event.target.value as "hour" | "day" | "month" } : undefined }))}><option>hour</option><option>day</option><option>month</option></select></label>
                </div>
                <h4>Score objectives</h4>
                <div className="grid smart-objectives">
                  {(["latency", "cost", "quality", "locality"] as const).map((objective) => <label key={objective}>{objective}<input type="number" min="0" value={rule.objectives?.[objective] ?? 0} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, objectives: { latency: 0, cost: 0, quality: 0, locality: 0, ...current.objectives, [objective]: Number(event.target.value) } }))} /></label>)}
                </div>
                <h4>Candidates</h4>
                <ModelSelector models={availableModels} value="" onChange={(model) => addCandidate(ruleIndex, model)} />
                <div className="smart-candidates">
                  {rule.candidates.map((candidate, candidateIndex) => (
                    <div className="smart-candidate" key={`${candidate.model}-${candidateIndex}`}>
                      <span className="badge">{candidateIndex + 1}</span>
                      <input className="mono" value={candidate.model} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { model: event.target.value })} />
                      <select value={candidate.provider ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { provider: (event.target.value || undefined) as RoutingCandidate["provider"] })}><option value="">Any provider</option><option>openai</option><option>openai-compatible</option><option>mistral</option><option>zai</option><option>xai</option></select>
                      <select value={candidate.location ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { location: (event.target.value || undefined) as RoutingCandidate["location"] })}><option value="">Account location</option><option>local</option><option>cloud</option></select>
                      <input placeholder="Account IDs, comma-separated" value={candidate.accountIds?.join(", ") ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { accountIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} />
                      <label>Quality <input type="number" min="0" max="100" value={candidate.quality ?? 50} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { quality: Number(event.target.value) })} /></label>
                      <label>Input $/M <input type="number" min="0" step="0.01" value={candidate.inputCostPerMillionUsd ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { inputCostPerMillionUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      <label>Output $/M <input type="number" min="0" step="0.01" value={candidate.outputCostPerMillionUsd ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { outputCostPerMillionUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      <label>Slots <input type="number" min="1" value={candidate.capacityProfile?.maxConcurrent ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, maxConcurrent: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Prefill tok/s <input type="number" min="0" value={candidate.capacityProfile?.prefillTokensPerSecond ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, prefillTokensPerSecond: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Decode tok/s <input type="number" min="0" value={candidate.capacityProfile?.decodeTokensPerSecond ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, decodeTokensPerSecond: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Context <input type="number" min="1" value={candidate.capacityProfile?.contextWindow ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, contextWindow: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <div className="inline"><button className="btn ghost" disabled={candidateIndex === 0} onClick={() => moveCandidate(ruleIndex, candidateIndex, -1)}>↑</button><button className="btn ghost" disabled={candidateIndex === rule.candidates.length - 1} onClick={() => moveCandidate(ruleIndex, candidateIndex, 1)}>↓</button></div>
                      <button className="btn danger" onClick={() => updateRule(ruleIndex, (current) => ({ ...current, candidates: current.candidates.filter((_, index) => index !== candidateIndex) }))}>Remove</button>
                    </div>
                  ))}
                  {!rule.candidates.length && <p className="muted">Add at least one model candidate.</p>}
                </div>
              </div>
            ))}
            <button className="btn ghost" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { ...blankRule(), id: `rule-${draft.rules.length + 1}` }] })}>Add rule</button>
          </>
        )}
        <div className="inline wrap smart-save-row">
          <button className="btn" disabled={saving || Boolean(jsonError) || !draft.id || draft.rules.some((rule) => !rule.candidates.length)} onClick={() => void save()}>{saving ? "Saving…" : originalId ? "Save policy" : "Create policy"}</button>
          <button className="btn ghost" onClick={() => selectDraft()}>Reset</button>
        </div>
      </section>

      <section className="smart-routing-observability">
        <div className="panel">
          <h2>Policy simulator</h2>
          <div className="grid smart-simulator-grid">
            <label>Application<input value={simulationRequest.application} onChange={(event) => setSimulationRequest({ ...simulationRequest, application: event.target.value })} /></label>
            <label>Priority<select value={simulationRequest.priority} onChange={(event) => setSimulationRequest({ ...simulationRequest, priority: event.target.value as PriorityClass })}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
            <label>Effort<input value={simulationRequest.effort} onChange={(event) => setSimulationRequest({ ...simulationRequest, effort: event.target.value })} /></label>
            <label>Input tokens<input type="number" value={simulationRequest.inputTokens} onChange={(event) => setSimulationRequest({ ...simulationRequest, inputTokens: Number(event.target.value) })} /></label>
            <label className="inline"><input type="checkbox" checked={simulationRequest.requiresTools} onChange={(event) => setSimulationRequest({ ...simulationRequest, requiresTools: event.target.checked })} />Tools</label>
          </div>
          <button className="btn" disabled={!draft.id || Boolean(jsonError)} onClick={() => void simulateAlias(draft, simulationRequest).then(setSimulation)}>Simulate</button>
          {simulation && <pre className="smart-result mono">{JSON.stringify(simulation, null, 2)}</pre>}
        </div>
        <div className="panel">
          <h2>Capacity and queue</h2>
          <div className="inline wrap">
            <select value={capacityPriority} onChange={(event) => setCapacityPriority(event.target.value as PriorityClass)}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select>
            <button className="btn" disabled={!draft.id} onClick={() => void loadCapacity(draft.id, capacityPriority).then(setCapacity)}>Refresh</button>
          </div>
          {capacity ? <div className="capacity-summary"><span className="badge badge-live">{capacity.state}</span><strong>{capacity.decision ?? "—"}</strong><span>{capacity.freeSlots} free slots</span><span>{capacity.estimatedWaitMs ?? "?"} ms wait</span><span>{capacity.queueDepth} queued</span><span>{capacity.confidence} confidence</span></div> : <p className="muted">Select or draft a policy to inspect application-visible capacity.</p>}
        </div>
      </section>

      <section className="panel alias-routing-panel">
        <h2>Image request model</h2>
        <div className="grid alias-grid"><label>Override model<ModelSelector models={availableModels} value={settings.imageRequestModelOverride ?? ""} onChange={(model) => void patchSettings({ imageRequestModelOverride: model || undefined })} /></label><button className="btn ghost" disabled={!settings.imageRequestModelOverride} onClick={() => void patchSettings({ imageRequestModelOverride: undefined })}>Clear override</button></div>
      </section>
    </>
  );
}
