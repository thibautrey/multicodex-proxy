import React, { useMemo, useState } from "react";
import type {
  ExposedModel,
  ModelAlias,
  PriorityClass,
  RoutingCandidate,
  RoutingRule,
  StoreSettings,
} from "../../types";
import {
  createAliasScenarioDraft,
  isGuidedScenarioComplete,
  withScenarioModels,
  type AliasCreationScenario,
  type GuidedAliasScenario,
} from "../../../../src/alias-policy-presets";
import {
  AliasScenarioPicker,
  GuidedAliasCreation,
} from "../aliases/AliasCreationWizard";
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

type AliasSection = "policies" | "editor" | "simulation" | "settings";

const ALIAS_SECTIONS: Array<{ id: AliasSection; label: string; description: string }> = [
  { id: "policies", label: "Policies", description: "Choose a policy to edit" },
  { id: "editor", label: "Policy editor", description: "Build matching and fallback rules" },
  { id: "simulation", label: "Simulation", description: "Test routing and capacity" },
  { id: "settings", label: "Settings", description: "Configure image requests" },
];

function HelpTooltip({ text }: { text: string }) {
  return <span className="help-tooltip" tabIndex={0} role="img" aria-label={text} data-tooltip={text}>?</span>;
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
  const [creationScenario, setCreationScenario] = useState<AliasCreationScenario>();
  const [guidedModels, setGuidedModels] = useState({ primary: "", fallback: "" });
  const [activeSection, setActiveSection] = useState<AliasSection>("policies");
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
    setCreationScenario(alias ? "advanced" : undefined);
    setGuidedModels({ primary: "", fallback: "" });
    setEditorMode("visual");
    setJsonDraft(JSON.stringify(next, null, 2));
    setJsonError(undefined);
    setSimulation(undefined);
    setCapacity(undefined);
  };

  const chooseCreationScenario = (scenario: AliasCreationScenario) => {
    if (scenario === "advanced") {
      const next = blankAlias();
      setDraft(next);
      setCreationScenario("advanced");
      setGuidedModels({ primary: "", fallback: "" });
      setJsonDraft(JSON.stringify(next, null, 2));
      return;
    }
    const next = createAliasScenarioDraft(scenario);
    setDraft(next);
    setCreationScenario(scenario);
    setGuidedModels({ primary: "", fallback: "" });
    setJsonDraft(JSON.stringify(next, null, 2));
  };

  const updateGuidedModel = (field: "primary" | "fallback", model: string) => {
    if (!creationScenario || creationScenario === "advanced") return;
    const nextModels = { ...guidedModels, [field]: model };
    setGuidedModels(nextModels);
    setDraft((current) => withScenarioModels(
      current,
      creationScenario,
      nextModels.primary,
      nextModels.fallback,
    ));
  };

  const openAdvancedEditor = () => {
    setCreationScenario("advanced");
    setJsonDraft(JSON.stringify(draft, null, 2));
    setEditorMode("visual");
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
    if (
      !draft.id.trim()
      || !draft.rules.length
      || draft.rules.some((rule) => !rule.candidates.length || rule.candidates.some((candidate) => !candidate.model.trim()))
    ) return;
    setSaving(true);
    try {
      const normalized = { ...draft, id: draft.id.trim() };
      if (originalId) await patchAlias(originalId, normalized);
      else await saveAlias(normalized);
      selectDraft();
      setActiveSection("policies");
    } finally {
      setSaving(false);
    }
  };

  const guidedScenario = creationScenario && creationScenario !== "advanced"
    ? creationScenario as GuidedAliasScenario
    : undefined;
  const guidedComplete = guidedScenario
    ? isGuidedScenarioComplete(
      guidedScenario,
      draft.id,
      guidedModels.primary,
      guidedModels.fallback,
    )
    : false;
  const draftComplete = Boolean(
    draft.id.trim()
    && draft.rules.length
    && draft.rules.every((rule) => rule.candidates.length && rule.candidates.every((candidate) => candidate.model.trim())),
  );

  return (
    <>
      <section className="panel alias-workspace-nav">
        <div className="section-split-header">
          <div>
            <h2>Alias workspace</h2>
            <p className="muted">Manage routing policies, test their decisions, and set the image fallback in separate workspaces.</p>
          </div>
          {originalId && <span className="badge badge-live">Editing <span className="mono">{originalId}</span></span>}
        </div>
        <div className="alias-tabs" role="tablist" aria-label="Alias workspace sections">
          {ALIAS_SECTIONS.map((section) => (
            <button
              key={section.id}
              className={`alias-tab ${activeSection === section.id ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeSection === section.id}
              aria-controls={`alias-panel-${section.id}`}
              onClick={() => setActiveSection(section.id)}
            >
              <span className="alias-tab-label">{section.label}</span>
              <span className="alias-tab-description">{section.description}</span>
            </button>
          ))}
        </div>
      </section>

      {activeSection === "policies" && <section className="panel alias-routing-panel" id="alias-panel-policies" role="tabpanel">
        <div className="section-split-header">
          <div>
            <h2>Smart routing policies</h2>
            <p className="muted">Versioned rules choose local or cloud capacity and decide whether work is queued.</p>
          </div>
          <button className="btn" type="button" onClick={() => { selectDraft(); setActiveSection("editor"); }} title="Start a new routing policy">New policy</button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Alias <HelpTooltip text="The model name your applications send to the proxy." /></th><th>Rules <HelpTooltip text="Rules are evaluated from top to bottom." /></th><th>Candidates <HelpTooltip text="Models available to this policy, in fallback order." /></th><th>Status</th><th /></tr></thead>
            <tbody>
              {aliases.map((alias) => (
                <tr key={alias.id}>
                  <td><span className="mono">{alias.id}</span><div className="muted">{alias.description}</div></td>
                  <td>{alias.rules.length}</td>
                  <td className="mono">{uniqueModels(alias).join(", ")}</td>
                  <td><span className={alias.enabled ? "badge badge-live" : "badge badge-warn"}>{alias.enabled ? "Enabled" : "Disabled"}</span></td>
                  <td className="inline wrap">
                    <button className="btn ghost" type="button" onClick={() => { selectDraft(alias); setActiveSection("editor"); }} title="Open this policy in the editor">Edit</button>
                    <button className="btn ghost" type="button" onClick={() => void patchAlias(alias.id, { enabled: !alias.enabled })} title={alias.enabled ? "Stop using this policy for new requests" : "Make this policy available for new requests"}>{alias.enabled ? "Disable" : "Enable"}</button>
                    <button className="btn danger" type="button" onClick={() => void deleteAlias(alias.id)} title="Permanently remove this policy">Delete</button>
                  </td>
                </tr>
              ))}
              {!aliases.length && <tr><td colSpan={5} className="muted empty-row">No policy yet. Create one to redirect a model or add fallback routing.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>}

      {activeSection === "editor" && <section className="panel smart-alias-editor" id="alias-panel-editor" role="tabpanel">
        <div className="section-split-header">
          <div>
            <h2>{originalId ? `Edit ${originalId}` : creationScenario ? "Configure your policy" : "Create a policy"}</h2>
            <p className="muted">
              {originalId || creationScenario === "advanced"
                ? "Rules run top to bottom. Candidate order breaks score ties."
                : "Start with the outcome you want. MultiVibe will prepare the routing policy."}
            </p>
          </div>
          {(originalId || creationScenario === "advanced") && <div className="inline wrap">
            {!originalId && <button className="btn ghost" type="button" onClick={() => selectDraft()} title="Discard this draft and choose a new goal">Start over</button>}
            <button className={`btn ${editorMode === "visual" ? "" : "ghost"}`} type="button" onClick={() => switchMode("visual")} title="Edit the policy with form fields">Visual</button>
            <button className={`btn ${editorMode === "json" ? "" : "ghost"}`} type="button" onClick={() => switchMode("json")} title="Edit the complete schema v2 document directly">JSON</button>
          </div>}
        </div>

        {!originalId && !creationScenario ? (
          <AliasScenarioPicker onSelect={chooseCreationScenario} />
        ) : guidedScenario ? (
          <GuidedAliasCreation
            scenario={guidedScenario}
            draft={draft}
            models={availableModels}
            primaryModel={guidedModels.primary}
            fallbackModel={guidedModels.fallback}
            complete={guidedComplete}
            saving={saving}
            onDraftChange={setDraft}
            onPrimaryModelChange={(model) => updateGuidedModel("primary", model)}
            onFallbackModelChange={(model) => updateGuidedModel("fallback", model)}
            onChangeGoal={() => selectDraft()}
            onAdvanced={openAdvancedEditor}
            onCreate={() => void save()}
          />
        ) : <>
        {editorMode === "json" ? (
          <label><span className="field-label">Validated schema v2 JSON <HelpTooltip text="Use JSON when you need access to every supported routing option. Changes are checked while you type." /></span>
            <textarea className="smart-json-editor mono" value={jsonDraft} onChange={(event) => parseJson(event.target.value)} />
            {jsonError && <span className="field-error">{jsonError}</span>}
          </label>
        ) : (
          <>
            <div className="grid smart-alias-basics">
              <label><span className="field-label">Alias <HelpTooltip text="The stable model name exposed to your applications. It cannot be changed after creation." /></span><input value={draft.id} disabled={Boolean(originalId)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="smart-code" /></label>
              <label><span className="field-label">Description <HelpTooltip text="A short note to help identify this policy in the list." /></span><input value={draft.description ?? ""} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <label><span className="field-label">Default priority <HelpTooltip text="Used when a request does not provide a priority that matches a rule." /></span><select value={draft.defaults?.priority ?? ""} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, priority: (event.target.value || undefined) as PriorityClass | undefined } })}><option value="">Legacy sync default</option>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
              <label className="inline"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>Enabled <HelpTooltip text="Disabled policies stay saved but are not selected for new requests." /></span></label>
            </div>

            {draft.rules.map((rule, ruleIndex) => (
              <div className="smart-rule" key={`${rule.id}-${ruleIndex}`}>
                <div className="section-split-header">
                  <h3>Rule {ruleIndex + 1} <HelpTooltip text="A rule applies when all of its matching conditions are met." /></h3>
                  <div className="inline wrap"><button className="btn ghost" type="button" disabled={ruleIndex === 0} onClick={() => moveRule(ruleIndex, -1)} title="Move rule earlier">↑</button><button className="btn ghost" type="button" disabled={ruleIndex === draft.rules.length - 1} onClick={() => moveRule(ruleIndex, 1)} title="Move rule later">↓</button><button className="btn danger" type="button" disabled={draft.rules.length === 1} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, index) => index !== ruleIndex) })} title="Remove this rule">Remove</button></div>
                </div>
                <h4>Match conditions <HelpTooltip text="These conditions decide whether a request enters this rule. Empty conditions match every request for that field." /></h4>
                <div className="grid smart-rule-grid">
                  <label><span className="field-label">Rule id <HelpTooltip text="An internal name for this rule. It is useful when reading simulation results." /></span><input value={rule.id} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, id: event.target.value }))} /></label>
                  <label><span className="field-label">Applications (comma-separated) <HelpTooltip text="Only requests from one of these application names match. Leave empty to match every application." /></span><input value={rule.match?.applications?.join(", ") ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, applications: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } }))} /></label>
                  <label><span className="field-label">Reasoning efforts <HelpTooltip text="Match requests by their requested reasoning effort, such as low, medium, or high." /></span><input value={rule.match?.efforts?.join(", ") ?? ""} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, efforts: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } }))} placeholder="low, medium, high" /></label>
                  <label><span className="field-label">Priorities <HelpTooltip text="Hold Ctrl or Cmd to select multiple priorities. An empty selection matches every priority." /></span><select multiple value={rule.match?.priorities ?? []} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, match: { ...current.match, priorities: Array.from(event.target.selectedOptions).map((option) => option.value as PriorityClass) } }))}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
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
                <h4>Score objectives <HelpTooltip text="Set the relative importance of latency, cost, quality, and locality when ranking matching candidates." /></h4>
                <div className="grid smart-objectives">
                  {(["latency", "cost", "quality", "locality"] as const).map((objective) => <label key={objective}>{objective}<input type="number" min="0" value={rule.objectives?.[objective] ?? 0} onChange={(event) => updateRule(ruleIndex, (current) => ({ ...current, objectives: { latency: 0, cost: 0, quality: 0, locality: 0, ...current.objectives, [objective]: Number(event.target.value) } }))} /></label>)}
                </div>
                <h4>Candidates <HelpTooltip text="Candidates are tried in this order after the rule matches. Add a fallback when the preferred model has no capacity." /></h4>
                <p className="field-help">Add models in preference order. The first available candidate handles the request.</p>
                <ModelSelector models={availableModels} value="" onChange={(model) => addCandidate(ruleIndex, model)} />
                <div className="smart-candidates">
                  {rule.candidates.map((candidate, candidateIndex) => (
                    <div className="smart-candidate" key={`${candidate.model}-${candidateIndex}`}>
                      <span className="badge">{candidateIndex + 1}</span>
                      <input className="mono" title="Model identifier used for this candidate" value={candidate.model} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { model: event.target.value })} />
                      <select title="Limit this candidate to a provider" value={candidate.provider ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { provider: (event.target.value || undefined) as RoutingCandidate["provider"] })}><option value="">Any provider</option><option>openai</option><option>openai-compatible</option><option>opencode</option><option>mistral</option><option>zai</option><option>xai</option></select>
                      <select title="Limit this candidate to local or cloud capacity" value={candidate.location ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { location: (event.target.value || undefined) as RoutingCandidate["location"] })}><option value="">Account location</option><option>local</option><option>cloud</option></select>
                      <input title="Optional account IDs, separated by commas" placeholder="Account IDs, comma-separated" value={candidate.accountIds?.join(", ") ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { accountIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} />
                      <label>Quality <input type="number" min="0" max="100" value={candidate.quality ?? 50} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { quality: Number(event.target.value) })} /></label>
                      <label>Input $/M <input type="number" min="0" step="0.01" value={candidate.inputCostPerMillionUsd ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { inputCostPerMillionUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      <label>Output $/M <input type="number" min="0" step="0.01" value={candidate.outputCostPerMillionUsd ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { outputCostPerMillionUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
                      <label>Slots <input type="number" min="1" value={candidate.capacityProfile?.maxConcurrent ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, maxConcurrent: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Prefill tok/s <input type="number" min="0" value={candidate.capacityProfile?.prefillTokensPerSecond ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, prefillTokensPerSecond: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Decode tok/s <input type="number" min="0" value={candidate.capacityProfile?.decodeTokensPerSecond ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, decodeTokensPerSecond: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <label>Context <input type="number" min="1" value={candidate.capacityProfile?.contextWindow ?? ""} onChange={(event) => updateCandidate(ruleIndex, candidateIndex, { capacityProfile: { ...candidate.capacityProfile, contextWindow: event.target.value ? Number(event.target.value) : undefined } })} /></label>
                      <div className="inline"><button className="btn ghost" type="button" disabled={candidateIndex === 0} onClick={() => moveCandidate(ruleIndex, candidateIndex, -1)} title="Move candidate earlier in fallback order">↑</button><button className="btn ghost" type="button" disabled={candidateIndex === rule.candidates.length - 1} onClick={() => moveCandidate(ruleIndex, candidateIndex, 1)} title="Move candidate later in fallback order">↓</button></div>
                      <button className="btn danger" type="button" onClick={() => updateRule(ruleIndex, (current) => ({ ...current, candidates: current.candidates.filter((_, index) => index !== candidateIndex) }))} title="Remove this candidate">Remove</button>
                    </div>
                  ))}
                  {!rule.candidates.length && <p className="muted">Add at least one model candidate.</p>}
                </div>
              </div>
            ))}
            <button className="btn ghost" type="button" onClick={() => setDraft({ ...draft, rules: [...draft.rules, { ...blankRule(), id: `rule-${draft.rules.length + 1}` }] })} title="Add another rule after the current rules">Add rule</button>
          </>
        )}
        <div className="inline wrap smart-save-row">
          <button className="btn" type="button" disabled={saving || Boolean(jsonError) || !draftComplete} onClick={() => void save()} title="Save this policy and return to the policy list">{saving ? "Saving…" : originalId ? "Save policy" : "Create policy"}</button>
          <button className="btn ghost" type="button" onClick={() => selectDraft()} title="Discard unsaved changes and start over">Reset</button>
        </div>
        </>}
      </section>}

      {activeSection === "simulation" && <section className="smart-routing-observability" id="alias-panel-simulation" role="tabpanel">
        <div className="panel">
          <div className="section-heading-with-help"><div><h2>Policy simulator</h2><p className="muted">Run a sample request through the policy currently open in the editor.</p></div><HelpTooltip text="Simulation does not send a real request. It shows which rule and candidate would be selected." /></div>
          <div className="grid smart-simulator-grid">
            <label><span className="field-label">Application <HelpTooltip text="The application name used to test application-specific matching." /></span><input value={simulationRequest.application} onChange={(event) => setSimulationRequest({ ...simulationRequest, application: event.target.value })} /></label>
            <label><span className="field-label">Priority <HelpTooltip text="The priority used to find a matching rule." /></span><select value={simulationRequest.priority} onChange={(event) => setSimulationRequest({ ...simulationRequest, priority: event.target.value as PriorityClass })}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
            <label><span className="field-label">Effort <HelpTooltip text="The reasoning effort used to test effort matching." /></span><input value={simulationRequest.effort} onChange={(event) => setSimulationRequest({ ...simulationRequest, effort: event.target.value })} /></label>
            <label><span className="field-label">Input tokens <HelpTooltip text="Approximate input size used to test token limits and capacity." /></span><input type="number" min="0" value={simulationRequest.inputTokens} onChange={(event) => setSimulationRequest({ ...simulationRequest, inputTokens: Number(event.target.value) })} /></label>
            <label className="inline"><input type="checkbox" checked={simulationRequest.requiresTools} onChange={(event) => setSimulationRequest({ ...simulationRequest, requiresTools: event.target.checked })} /><span>Tools required <HelpTooltip text="Test a request that requires tool support." /></span></label>
          </div>
          <button className="btn" type="button" disabled={!draft.id || Boolean(jsonError)} onClick={() => void simulateAlias(draft, simulationRequest).then(setSimulation)} title={!draft.id ? "Open or create a policy first" : "Evaluate the sample request"}>Simulate</button>
          {!draft.id && <p className="muted inline-notice">Open a policy from the Policies tab before running a simulation.</p>}
          {simulation && <pre className="smart-result mono">{JSON.stringify(simulation, null, 2)}</pre>}
        </div>
        <div className="panel">
          <div className="section-heading-with-help"><div><h2>Capacity and queue</h2><p className="muted">Inspect the capacity decision for the selected priority.</p></div><HelpTooltip text="This check reads current capacity and queue data for the policy alias." /></div>
          <div className="inline wrap">
            <label><span className="sr-only">Capacity priority</span><select value={capacityPriority} onChange={(event) => setCapacityPriority(event.target.value as PriorityClass)}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
            <button className="btn" type="button" disabled={!draft.id} onClick={() => void loadCapacity(draft.id, capacityPriority).then(setCapacity)} title={!draft.id ? "Open or create a policy first" : "Refresh capacity and queue data"}>Refresh</button>
          </div>
          {capacity ? <div className="capacity-summary"><span className="badge badge-live">{capacity.state}</span><strong>{capacity.decision ?? "—"}</strong><span>{capacity.freeSlots} free slots</span><span>{capacity.estimatedWaitMs ?? "?"} ms wait</span><span>{capacity.queueDepth} queued</span><span>{capacity.confidence} confidence</span></div> : <p className="muted">Select or draft a policy to inspect application-visible capacity.</p>}
        </div>
      </section>}

      {activeSection === "settings" && <section className="panel alias-routing-panel" id="alias-panel-settings" role="tabpanel">
        <div className="section-heading-with-help"><div><h2>Image request model</h2><p className="muted">Optionally route image requests to a specific model instead of the default.</p></div><HelpTooltip text="This override only affects image requests. Leave it empty to use the normal model selection." /></div>
        <div className="grid alias-grid"><label><span className="field-label">Override model <HelpTooltip text="The model that will handle image requests when an override is configured." /></span><ModelSelector models={availableModels} value={settings.imageRequestModelOverride ?? ""} onChange={(model) => void patchSettings({ imageRequestModelOverride: model || undefined })} /></label><button className="btn ghost" type="button" disabled={!settings.imageRequestModelOverride} onClick={() => void patchSettings({ imageRequestModelOverride: undefined })} title="Remove the image model override">Clear override</button></div>
      </section>}
    </>
  );
}
