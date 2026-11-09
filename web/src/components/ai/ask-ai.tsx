import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, Send, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import {
  ASK_EVENT,
  PROVIDER_LABELS,
  askAi,
  getOpenFile,
  useAiProviders,
  useDefaultProvider,
  type AskContext,
  type ProviderId,
  type Turn,
} from "@/lib/ai";
import { cn } from "@/lib/cn";

/* Ask your own AI (Claude / Gemini / ChatGPT CLIs on this Mac) about
 * selected text or the open file. Backend: app/routers/ai.py. */

/** Settings → AI assistant. */
export function AiSettingsCard() {
  const { t } = useTranslation();
  const { data, isPending } = useAiProviders();
  const [provider, setProvider] = useDefaultProvider();
  if (isPending) return <Loader2 className="h-4 w-4 animate-spin text-muted" />;
  if (!data?.local_mode) return <p className="text-sm text-muted">{t("ai.needsLocalMode")}</p>;
  const active = provider ?? data.providers.find((p) => p.installed)?.id;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted mb-1">{t("ai.settingsBody")}</p>
      {data.providers.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={!p.installed}
          onClick={() => setProvider(p.id)}
          className={cn(
            "flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
            active === p.id ? "border-fg/60 bg-surface-2" : "border-border/60 hover:bg-surface-2/60",
            !p.installed && "opacity-70 cursor-default hover:bg-transparent"
          )}
        >
          <span className="h-4 w-4 shrink-0 flex items-center justify-center">
            {active === p.id && p.installed && <Check className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{PROVIDER_LABELS[p.id]}</span>
            <span className="block text-xs text-muted">
              {p.installed ? t("ai.installed") : t("ai.notInstalled", { hint: p.hint })}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Selection popup + Ask sidebar. Mounted once in the app shell. */
export function AskAi() {
  const { t } = useTranslation();
  const providers = useAiProviders();
  const [savedProvider, setSavedProvider] = useDefaultProvider();
  const installed = (providers.data?.providers ?? []).filter((p) => p.installed);
  const enabled = Boolean(providers.data?.local_mode && installed.length);
  const provider = installed.some((p) => p.id === savedProvider) ? savedProvider! : installed[0]?.id;

  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<AskContext>({});
  const [page, setPage] = useState("");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [popup, setPopup] = useState<{ x: number; y: number; text: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const ask = useMutation({
    mutationFn: (q: string) =>
      api.post<{ answer: string }>("/api/ai/ask", {
        provider,
        question: q,
        selection: ctx.selection,
        path: ctx.path,
        page: ctx.path?.toLowerCase().endsWith(".pdf") && Number(page) > 0 ? Number(page) : undefined,
        history,
      }),
    onSuccess: (r, q) => setHistory((h) => [...h, { question: q, answer: r.answer }]),
  });

  // Open from askAi(): a new context starts a new conversation.
  const resetAsk = ask.reset;
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<AskContext>).detail;
      setCtx(detail);
      setHistory([]);
      setPage("");
      resetAsk();
      setOpen(true);
      setPopup(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener(ASK_EVENT, h);
    return () => window.removeEventListener(ASK_EVENT, h);
  }, [resetAsk]);

  // Floating "Ask AI" button next to selected text.
  useEffect(() => {
    if (!enabled) return;
    function onUp(e: MouseEvent | KeyboardEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
      if (!sel || sel.rangeCount === 0 || text.length < 3 || inField) {
        setPopup(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setPopup({ x: Math.min(r.left + r.width / 2, window.innerWidth - 60), y: r.bottom + 8, text });
    }
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement)?.closest?.("[data-ask-popup]")) setPopup(null);
    }
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("mousedown", onDown);
    };
  }, [enabled]);

  if (!enabled) return null;

  function send() {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setQuestion("");
    ask.mutate(q);
  }

  const isPdf = ctx.path?.toLowerCase().endsWith(".pdf");

  return (
    <>
      {popup && (
        <button
          type="button"
          data-ask-popup
          onClick={() => askAi({ selection: popup.text, path: getOpenFile() ?? undefined })}
          style={{ left: popup.x, top: popup.y }}
          className="fixed z-[70] -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface px-3 py-1.5 text-xs font-medium shadow-lg hover:bg-surface-2"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("ai.ask")}
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("ai.ask")}
          className="fixed z-[60] inset-x-0 bottom-0 h-[85dvh] sm:inset-auto sm:right-0 sm:top-0 sm:h-[100dvh] sm:w-[420px] flex flex-col bg-surface text-fg border-t sm:border-t-0 sm:border-l border-border/60 shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="text-sm font-semibold flex-1">{t("ai.ask")}</span>
            <select
              value={provider}
              onChange={(e) => setSavedProvider(e.target.value as ProviderId)}
              aria-label={t("ai.provider")}
              className="rounded-md border border-border/60 bg-surface-2 px-2 py-1 text-sm"
            >
              {installed.map((p) => (
                <option key={p.id} value={p.id}>
                  {PROVIDER_LABELS[p.id]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3 text-sm">
            {ctx.path && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="truncate flex-1" title={ctx.path}>
                  {t("ai.file", { name: ctx.path.split("/").pop() })}
                </span>
                {isPdf && (
                  <label className="flex items-center gap-1 shrink-0">
                    {t("ai.page")}
                    <input
                      type="number"
                      min={1}
                      value={page}
                      onChange={(e) => setPage(e.target.value)}
                      placeholder={t("ai.pageAll")}
                      className="w-16 rounded border border-border/60 bg-surface-2 px-1.5 py-0.5 text-fg"
                    />
                  </label>
                )}
              </div>
            )}
            {ctx.selection && (
              <blockquote className="border-l-2 border-border pl-3 text-muted line-clamp-6 whitespace-pre-wrap">
                {ctx.selection}
              </blockquote>
            )}
            {history.map((turn, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <p className="font-medium">{turn.question}</p>
                <p className="whitespace-pre-wrap leading-relaxed">{turn.answer}</p>
              </div>
            ))}
            {ask.isPending && (
              <div className="flex flex-col gap-1.5">
                <p className="font-medium">{ask.variables}</p>
                <p className="flex items-center gap-2 text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("ai.thinking", { name: PROVIDER_LABELS[provider] })}
                </p>
              </div>
            )}
            {ask.error && <p className="text-critical">{(ask.error as Error).message}</p>}
          </div>

          <div className="border-t border-border/60 p-3 flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={t("ai.placeholder")}
              className="flex-1 resize-none rounded-md border border-border/60 bg-surface-2 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={send}
              disabled={!question.trim() || ask.isPending}
              aria-label={t("ai.send")}
              className="touch-target inline-flex items-center justify-center rounded-md bg-fg text-bg px-3 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
