import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/* Shared state + hooks for the Ask AI panel (components/ai/ask-ai.tsx). */

export type ProviderId = "claude" | "gemini" | "chatgpt";
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
  chatgpt: "ChatGPT",
};
type ProvidersResponse = {
  local_mode: boolean;
  providers: { id: ProviderId; installed: boolean; hint: string }[];
};
export type AskContext = { selection?: string; path?: string };
export type Turn = { question: string; answer: string };

const STORAGE_KEY = "openstudy.aiProvider";
export const ASK_EVENT = "openstudy:ask";

// ponytail: module-level "which file is open" — one viewer at a time; a context if that changes.
let openFile: string | null = null;
export function setOpenFile(path: string | null) {
  openFile = path;
}
export function getOpenFile() {
  return openFile;
}

/** Open the Ask panel from anywhere (file viewer button, selection popup). */
export function askAi(ctx: AskContext) {
  window.dispatchEvent(new CustomEvent<AskContext>(ASK_EVENT, { detail: ctx }));
}

export function useAiProviders() {
  return useQuery({
    queryKey: ["ai", "providers"],
    queryFn: () => api.get<ProvidersResponse>("/api/ai/providers"),
    staleTime: 5 * 60_000,
  });
}

export function useDefaultProvider(): [ProviderId | null, (p: ProviderId) => void] {
  const [value, setValue] = useState<ProviderId | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) as ProviderId | null;
    } catch {
      return null;
    }
  });
  function set(p: ProviderId) {
    setValue(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* private mode: keep it for this session only */
    }
  }
  return [value, set];
}
