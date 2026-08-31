import type { ModelAlias, RoutingCandidateConfig, RoutingRule } from "./types.js";

export type AliasCreationScenario =
  | "redirect"
  | "fallback"
  | "local-cloud"
  | "advanced";

export type GuidedAliasScenario = Exclude<AliasCreationScenario, "advanced">;

export type AliasScenarioDefinition = {
  id: AliasCreationScenario;
  title: string;
  description: string;
  outcome: string;
  badge?: string;
};

export const ALIAS_CREATION_SCENARIOS: AliasScenarioDefinition[] = [
  {
    id: "redirect",
    title: "Redirect a model name",
    description: "Keep the model name already used by your app and send its requests to another model.",
    outcome: "One requested name → one destination model",
    badge: "Simplest",
  },
  {
    id: "fallback",
    title: "Add a fallback model",
    description: "Use a preferred model first, then automatically try a second model when it is unavailable.",
    outcome: "Primary model → fallback model",
  },
  {
    id: "local-cloud",
    title: "Prefer local, overflow to cloud",
    description: "Run on local capacity whenever possible and use a cloud model only when local capacity is unavailable.",
    outcome: "Local model → cloud model",
  },
  {
    id: "advanced",
    title: "Build a custom policy",
    description: "Configure matching rules, priorities, budgets, scoring, capacity and execution modes yourself.",
    outcome: "Full routing policy editor",
    badge: "Advanced",
  },
];

const orderedRule = (id: string, onNoCapacity: RoutingRule["onNoCapacity"]): RoutingRule => ({
  id,
  candidates: [],
  objectives: { latency: 0, cost: 0, quality: 100, locality: 0 },
  onNoCapacity,
});

export function createAliasScenarioDraft(scenario: GuidedAliasScenario): ModelAlias {
  if (scenario === "redirect") {
    return {
      schemaVersion: 2,
      id: "",
      enabled: true,
      description: "Redirect an existing model name",
      rules: [orderedRule("redirect", "reject")],
    };
  }

  if (scenario === "fallback") {
    return {
      schemaVersion: 2,
      id: "",
      enabled: true,
      description: "Prefer one model and fall back to another",
      rules: [orderedRule("fallback", "queue")],
    };
  }

  return {
    schemaVersion: 2,
    id: "",
    enabled: true,
    description: "Prefer local capacity and overflow to cloud",
    rules: [{
      ...orderedRule("local-first", "queue"),
      constraints: { allowedLocations: ["local", "cloud"] },
      objectives: { latency: 0, cost: 0, quality: 0, locality: 100 },
    }],
  };
}

export function scenarioNeedsFallback(scenario: GuidedAliasScenario): boolean {
  return scenario !== "redirect";
}

export function withScenarioModels(
  alias: ModelAlias,
  scenario: GuidedAliasScenario,
  primaryModel: string,
  fallbackModel: string,
): ModelAlias {
  const candidates: RoutingCandidateConfig[] = [];
  const primary = primaryModel.trim();
  const fallback = fallbackModel.trim();

  if (primary) {
    candidates.push({
      model: primary,
      quality: 50,
      ...(scenario === "local-cloud" ? { location: "local" as const } : {}),
    });
  }
  if (scenarioNeedsFallback(scenario) && fallback) {
    candidates.push({
      model: fallback,
      quality: 50,
      ...(scenario === "local-cloud" ? { location: "cloud" as const } : {}),
    });
  }

  return {
    ...alias,
    rules: alias.rules.map((rule, index) => index === 0 ? { ...rule, candidates } : rule),
  };
}

export function isGuidedScenarioComplete(
  scenario: GuidedAliasScenario,
  aliasId: string,
  primaryModel: string,
  fallbackModel: string,
): boolean {
  if (!aliasId.trim() || !primaryModel.trim()) return false;
  if (!scenarioNeedsFallback(scenario)) return true;
  return Boolean(
    fallbackModel.trim() &&
    fallbackModel.trim().toLowerCase() !== primaryModel.trim().toLowerCase(),
  );
}
