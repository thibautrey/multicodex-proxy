import type { Account } from "../types";

export type RuntimeIdentity = {
  id: string;
  label: string;
  iconUrl: string;
  homepageUrl?: string;
};

const GENERIC_RUNTIME_ICON = "/assets/brand/favicon.svg";

const RUNTIME_CATALOG: Record<string, RuntimeIdentity> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    iconUrl: "https://openai.com/favicon.ico",
    homepageUrl: "https://openai.com",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    iconUrl: "https://mistral.ai/favicon.ico",
    homepageUrl: "https://mistral.ai",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    iconUrl: "https://opencode.ai/favicon-v3.svg",
    homepageUrl: "https://opencode.ai",
  },
  zai: {
    id: "zai",
    label: "z.ai",
    iconUrl: "https://z.ai/favicon.png",
    homepageUrl: "https://z.ai",
  },
  xai: {
    id: "xai",
    label: "Grok Build",
    iconUrl: "https://grok.com/favicon.ico",
    homepageUrl: "https://grok.com",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    iconUrl: "/assets/runtime/ollama.svg",
    homepageUrl: "https://ollama.com",
  },
  "lm-studio": {
    id: "lm-studio",
    label: "LM Studio",
    iconUrl: "/assets/runtime/lm-studio.svg",
    homepageUrl: "https://lmstudio.ai",
  },
  omlx: {
    id: "omlx",
    label: "OMLX",
    iconUrl: "/assets/runtime/omlx.svg",
    homepageUrl: "https://omlx.ai",
  },
  mtplx: {
    id: "mtplx",
    label: "MTPLX",
    iconUrl: "/assets/runtime/mtplx.png",
    homepageUrl: "https://github.com/youssofal/MTPLX",
  },
  exo: {
    id: "exo",
    label: "Exo",
    iconUrl: "/assets/runtime/exo.png",
    homepageUrl: "https://github.com/exo-explore/exo",
  },
  "llama-cpp": { id: "llama-cpp", label: "llama.cpp", iconUrl: GENERIC_RUNTIME_ICON },
  vllm: { id: "vllm", label: "vLLM", iconUrl: GENERIC_RUNTIME_ICON },
  sglang: { id: "sglang", label: "SGLang", iconUrl: GENERIC_RUNTIME_ICON },
  localai: { id: "localai", label: "LocalAI", iconUrl: GENERIC_RUNTIME_ICON },
  "huggingface-tgi": { id: "huggingface-tgi", label: "Hugging Face TGI", iconUrl: GENERIC_RUNTIME_ICON },
  "transformers-serve": { id: "transformers-serve", label: "Transformers Serve", iconUrl: GENERIC_RUNTIME_ICON },
  xinference: { id: "xinference", label: "Xinference", iconUrl: GENERIC_RUNTIME_ICON },
  "mlx-lm": { id: "mlx-lm", label: "MLX-LM", iconUrl: GENERIC_RUNTIME_ICON },
  "mlc-llm": { id: "mlc-llm", label: "MLC LLM", iconUrl: GENERIC_RUNTIME_ICON },
  jan: { id: "jan", label: "Jan", iconUrl: GENERIC_RUNTIME_ICON },
  gpt4all: { id: "gpt4all", label: "GPT4All", iconUrl: GENERIC_RUNTIME_ICON },
  koboldcpp: { id: "koboldcpp", label: "KoboldCpp", iconUrl: GENERIC_RUNTIME_ICON },
  "text-generation-webui": { id: "text-generation-webui", label: "text-generation-webui", iconUrl: GENERIC_RUNTIME_ICON },
  aphrodite: { id: "aphrodite", label: "Aphrodite", iconUrl: GENERIC_RUNTIME_ICON },
  tabbyapi: { id: "tabbyapi", label: "TabbyAPI", iconUrl: GENERIC_RUNTIME_ICON },
  "llama-box": { id: "llama-box", label: "llama-box", iconUrl: GENERIC_RUNTIME_ICON },
  "mistral-rs": { id: "mistral-rs", label: "mistral.rs", iconUrl: GENERIC_RUNTIME_ICON },
  "nvidia-nim": { id: "nvidia-nim", label: "NVIDIA NIM", iconUrl: GENERIC_RUNTIME_ICON },
  "tensorrt-llm": { id: "tensorrt-llm", label: "TensorRT-LLM", iconUrl: GENERIC_RUNTIME_ICON },
  triton: { id: "triton", label: "NVIDIA Triton", iconUrl: GENERIC_RUNTIME_ICON },
  openllm: { id: "openllm", label: "OpenLLM", iconUrl: GENERIC_RUNTIME_ICON },
  bentoml: { id: "bentoml", label: "BentoML", iconUrl: GENERIC_RUNTIME_ICON },
  "manual-openai-compatible": {
    id: "manual-openai-compatible",
    label: "OpenAI-compatible",
    iconUrl: GENERIC_RUNTIME_ICON,
  },
};

function fallbackIdentity(id: string, label?: string): RuntimeIdentity {
  return {
    id,
    label: label ?? id,
    iconUrl: GENERIC_RUNTIME_ICON,
  };
}

export function runtimeIdentityForAdapter(
  adapter?: string,
  displayName?: string,
): RuntimeIdentity {
  const id = adapter?.trim() || "unknown-runtime";
  const identity = RUNTIME_CATALOG[id];
  if (!identity) return fallbackIdentity(id, displayName);
  return displayName && identity.iconUrl === GENERIC_RUNTIME_ICON
    ? { ...identity, label: displayName }
    : identity;
}

export function runtimeIdentityForProvider(provider?: string): RuntimeIdentity {
  if (!provider) return runtimeIdentityForAdapter("openai");
  return runtimeIdentityForAdapter(provider);
}

export function runtimeIdentityForAccount(
  account: Pick<Account, "provider" | "localRuntime">,
): RuntimeIdentity {
  if (account.localRuntime?.adapter) {
    return runtimeIdentityForAdapter(account.localRuntime.adapter);
  }
  return runtimeIdentityForProvider(account.provider);
}
