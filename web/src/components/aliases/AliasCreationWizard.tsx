import React from "react";
import {
  ALIAS_CREATION_SCENARIOS,
  scenarioNeedsFallback,
  type AliasCreationScenario,
  type GuidedAliasScenario,
} from "../../../../src/alias-policy-presets";
import type { ExposedModel, ModelAlias, RoutingRule } from "../../types";
import { ModelSelector } from "../ui/ModelSelector";

type ScenarioPickerProps = {
  onSelect: (scenario: AliasCreationScenario) => void;
};

export function AliasScenarioPicker({ onSelect }: ScenarioPickerProps) {
  return (
    <div className="alias-wizard">
      <WizardProgress step={1} complete={false} />
      <div className="alias-wizard-intro">
        <h3>What do you want this alias to do?</h3>
      </div>
      <div className="alias-scenario-grid">
        {ALIAS_CREATION_SCENARIOS.map((scenario) => (
          <button
            className={`alias-scenario-card${scenario.id === "advanced" ? " advanced" : ""}`}
            key={scenario.id}
            type="button"
            onClick={() => onSelect(scenario.id)}
          >
            <span className="alias-scenario-card-heading">
              <strong>{scenario.title}</strong>
              {scenario.badge && <span className="badge">{scenario.badge}</span>}
            </span>
            <span>{scenario.description}</span>
            <small>{scenario.outcome}</small>
            <span className="alias-scenario-action">Choose this goal →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type GuidedWizardProps = {
  scenario: GuidedAliasScenario;
  draft: ModelAlias;
  models: ExposedModel[];
  primaryModel: string;
  fallbackModel: string;
  complete: boolean;
  saving: boolean;
  onDraftChange: (draft: ModelAlias) => void;
  onPrimaryModelChange: (model: string) => void;
  onFallbackModelChange: (model: string) => void;
  onChangeGoal: () => void;
  onAdvanced: () => void;
  onCreate: () => void;
};

const scenarioCopy: Record<GuidedAliasScenario, {
  requestedNameHelp: string;
  primaryLabel: string;
  primaryHelp: string;
  fallbackLabel?: string;
  fallbackHelp?: string;
}> = {
  redirect: {
    requestedNameHelp: "This is the model name your application already sends, for example gpt-5.4.",
    primaryLabel: "Destination model",
    primaryHelp: "Every request using the name above will be sent to this model.",
  },
  fallback: {
    requestedNameHelp: "This stable name is what your application will send to the proxy.",
    primaryLabel: "Preferred model",
    primaryHelp: "This model is used whenever it has available capacity.",
    fallbackLabel: "Fallback model",
    fallbackHelp: "This model is tried when the preferred model has no available capacity.",
  },
  "local-cloud": {
    requestedNameHelp: "This stable name is what your application will send to the proxy.",
    primaryLabel: "Local model",
    primaryHelp: "Only local accounts exposing this model are eligible for the first choice.",
    fallbackLabel: "Cloud model",
    fallbackHelp: "Only cloud accounts exposing this model are eligible for overflow.",
  },
};

export function GuidedAliasCreation({
  scenario,
  draft,
  models,
  primaryModel,
  fallbackModel,
  complete,
  saving,
  onDraftChange,
  onPrimaryModelChange,
  onFallbackModelChange,
  onChangeGoal,
  onAdvanced,
  onCreate,
}: GuidedWizardProps) {
  const definition = ALIAS_CREATION_SCENARIOS.find((item) => item.id === scenario)!;
  const copy = scenarioCopy[scenario];
  const duplicateFallback = scenarioNeedsFallback(scenario)
    && Boolean(primaryModel)
    && primaryModel.toLowerCase() === fallbackModel.toLowerCase();
  const firstRule = draft.rules[0];

  const updateNoCapacity = (value: RoutingRule["onNoCapacity"]) => {
    onDraftChange({
      ...draft,
      rules: draft.rules.map((rule, index) => index === 0 ? { ...rule, onNoCapacity: value } : rule),
    });
  };

  return (
    <div className="alias-wizard">
      <WizardProgress step={2} complete={complete} />
      <div className="section-split-header alias-wizard-selected-goal">
        <div>
          <span className="eyebrow">Selected goal</span>
          <h3>{definition.title}</h3>
          <p className="muted">{definition.description}</p>
        </div>
        <button className="btn ghost" type="button" onClick={onChangeGoal}>Change goal</button>
      </div>

      <div className="alias-guided-layout">
        <div className="alias-guided-fields">
          <label>
            <span className="field-label">Model name requested by your application</span>
            <input
              autoFocus
              list="alias-requested-models"
              value={draft.id}
              onChange={(event) => onDraftChange({ ...draft, id: event.target.value })}
              placeholder={scenario === "redirect" ? "gpt-5.4" : "my-model-alias"}
            />
            <small>{copy.requestedNameHelp}</small>
          </label>
          <datalist id="alias-requested-models">
            {models.map((model) => <option key={model.id} value={model.id} />)}
          </datalist>

          <label>
            <span className="field-label">{copy.primaryLabel}</span>
            <ModelSelector models={models} value={primaryModel} onChange={onPrimaryModelChange} />
            <small>{copy.primaryHelp}</small>
          </label>

          {scenarioNeedsFallback(scenario) && (
            <label>
              <span className="field-label">{copy.fallbackLabel}</span>
              <ModelSelector models={models} value={fallbackModel} onChange={onFallbackModelChange} />
              <small>{copy.fallbackHelp}</small>
              {duplicateFallback && <span className="field-error">Choose a different fallback model.</span>}
            </label>
          )}

          <label>
            <span className="field-label">If every configured model is unavailable</span>
            <select
              value={firstRule?.onNoCapacity ?? "reject"}
              onChange={(event) => updateNoCapacity(event.target.value as RoutingRule["onNoCapacity"])}
            >
              <option value="queue">Wait in the queue</option>
              <option value="reject">Return an error immediately</option>
            </select>
            <small>This only applies after all choices above have been tried.</small>
          </label>

          <label>
            <span className="field-label">Description <span className="muted">(optional)</span></span>
            <input
              value={draft.description ?? ""}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
            />
          </label>
        </div>

        <aside className="alias-route-preview" aria-label="Routing preview">
          <span className="eyebrow">Routing preview</span>
          <h4>What will happen</h4>
          <div className="alias-route-flow">
            <RouteStep label="Application requests" value={draft.id || "model name"} />
            <span className="alias-route-arrow">↓</span>
            <RouteStep
              label={scenario === "local-cloud" ? "Local first" : "Proxy uses"}
              value={primaryModel || copy.primaryLabel.toLowerCase()}
              active={Boolean(primaryModel)}
            />
            {scenarioNeedsFallback(scenario) && (
              <>
                <span className="alias-route-arrow">↓ if unavailable</span>
                <RouteStep
                  label={scenario === "local-cloud" ? "Cloud overflow" : "Then fallback"}
                  value={fallbackModel || copy.fallbackLabel!.toLowerCase()}
                  active={Boolean(fallbackModel)}
                />
              </>
            )}
          </div>
          <p className="muted">
            Your application only sends the requested model name. MultiVibe handles the redirection and fallback.
          </p>
        </aside>
      </div>

      <div className="alias-wizard-actions">
        <button className="btn ghost" type="button" onClick={onAdvanced}>Open advanced settings</button>
        <button className="btn" type="button" disabled={!complete || saving} onClick={onCreate}>
          {saving ? "Creating…" : "Create policy"}
        </button>
      </div>
    </div>
  );
}

function WizardProgress({ step, complete }: { step: 1 | 2; complete: boolean }) {
  return (
    <ol className="alias-wizard-progress" aria-label="Policy creation progress">
      <li className={step >= 1 ? "active" : ""}><span>{step > 1 ? "✓" : "1"}</span>Choose a goal</li>
      <li className={step >= 2 ? "active" : ""}><span>2</span>Configure</li>
      <li className={complete ? "active" : ""}><span>{complete ? "✓" : "3"}</span>Ready to create</li>
    </ol>
  );
}

function RouteStep({ label, value, active = false }: { label: string; value: string; active?: boolean }) {
  return (
    <div className={`alias-route-step${active ? " active" : ""}`}>
      <small>{label}</small>
      <strong className="mono">{value}</strong>
    </div>
  );
}
