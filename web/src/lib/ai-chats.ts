/* Saved, shared Ask AI chats (backend: app/routers/ai_chats.py). Everyone with
 * AI access sees every chat, so lists and open chats poll for each other's
 * messages. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { ProviderId } from "./ai";

export type ChatSummary = {
  id: string;
  title: string;
  updated_at: string;
  created_by_name: string | null;
  messages: number;
};
export type ChatMessage = {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  provider: ProviderId | null;
  model: string | null;
  context: { path?: string; page?: number; selection?: string } | null;
  created_at: string;
  author_name: string | null;
  images: string[];
};
export type Chat = { id: string; title: string; messages: ChatMessage[]; pending: boolean };
export type ModelOption = { id: string; label: string };
export type PastedImage = { mime: string; data: string; url: string }; // data = base64, url = preview

export function useChats(enabled: boolean) {
  return useQuery({
    queryKey: ["ai", "chats"],
    queryFn: () => api.get<ChatSummary[]>("/api/ai/chats"),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useChat(id: string | null, sending: boolean) {
  return useQuery({
    queryKey: ["ai", "chat", id],
    queryFn: () => api.get<Chat>(`/api/ai/chats/${id}`),
    enabled: Boolean(id),
    // Faster while someone's question is waiting for an answer.
    refetchInterval: (q) => (q.state.data?.pending || sending ? 2_500 : 6_000),
  });
}

export function useModels(enabled: boolean) {
  return useQuery({
    queryKey: ["ai", "models"],
    queryFn: () => api.get<Partial<Record<ProviderId, ModelOption[]>>>("/api/ai/models"),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export type SendInput = {
  chatId: string | null;
  provider: ProviderId;
  model: string;
  question: string;
  selection?: string;
  path?: string;
  page?: number;
  images: PastedImage[];
  /** Course folder the AI may read (Claude); "" = off. */
  course: string;
};

export function useSendMessage(onChatCreated: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendInput) => {
      let chatId = input.chatId;
      if (!chatId) {
        chatId = (await api.post<{ id: string }>("/api/ai/chats", {})).id;
        onChatCreated(chatId);
      }
      qc.invalidateQueries({ queryKey: ["ai", "chats"] });
      return api.post<Chat>(`/api/ai/chats/${chatId}/messages`, {
        provider: input.provider,
        model: input.model,
        question: input.question,
        selection: input.selection,
        path: input.path,
        page: input.page,
        images: input.images.map(({ mime, data }) => ({ mime, data })),
        course: input.course,
      });
    },
    onSuccess: (chat) => {
      qc.setQueryData(["ai", "chat", chat.id], chat);
      qc.invalidateQueries({ queryKey: ["ai", "chats"] });
    },
  });
}

export function useRenameChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patch(`/api/ai/chats/${id}`, { title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai"] }),
  });
}

export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/ai/chats/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "chats"] }),
  });
}

/** A value kept in localStorage (per browser), e.g. panel width or chosen model. */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private mode: keep it for this session */
      }
    },
  ];
}

const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BYTES = 4_500_000; // server allows 5 MB; leave room

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Big or unusual images (HEIC, huge screenshots) are redrawn as JPEG ≤ 2400 px. */
async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't convert image"))), "image/jpeg", 0.85)
  );
}

export async function prepareImage(file: Blob): Promise<PastedImage> {
  const blob = ACCEPTED.includes(file.type) && file.size <= MAX_BYTES ? file : await shrink(file);
  if (blob.size > MAX_BYTES) throw new Error("image is too large");
  return { mime: blob.type, data: await toBase64(blob), url: URL.createObjectURL(blob) };
}
