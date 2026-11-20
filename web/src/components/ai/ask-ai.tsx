import { useEffect, useRef, useState } from "react";
import {
  Check,
  ImagePlus,
  Loader2,
  PanelLeft,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  ASK_EVENT,
  PROVIDER_LABELS,
  askAi,
  currentContext,
  useAiProviders,
  useDefaultProvider,
  type AskContext,
  type ProviderId,
} from "@/lib/ai";
import {
  prepareImage,
  useChat,
  useChats,
  useDeleteChat,
  useModels,
  useRenameChat,
  useSendMessage,
  useStored,
  type ChatMessage,
  type PastedImage,
} from "@/lib/ai-chats";
import { fmtDateShort } from "@/lib/time";
import { cn } from "@/lib/cn";
import { Markdown } from "./markdown";

/* Ask AI (Claude / Gemini via the AI CLIs of the computer hosting OpenStudy)
 * about selected text, the open file or pasted images. Chats are saved and
 * shared with everyone who has AI access. Backend: app/routers/ai.py,
 * app/routers/ai_chats.py. */

/** Settings → AI assistant. */
export function AiSettingsCard() {
  const { t } = useTranslation();
  const { data, isPending } = useAiProviders();
  const [provider, setProvider] = useDefaultProvider();
  if (isPending) return <Loader2 className="h-4 w-4 animate-spin text-muted" />;
  if (!(data?.ai_enabled ?? data?.local_mode)) return <p className="text-sm text-muted">{t("ai.needsLocalMode")}</p>;
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

const MIN_W = 340;
const DEFAULT_W = 520;
const maxWidth = () => Math.min(1200, Math.round(window.innerWidth * 0.95));
const clampWidth = (w: number) => Math.max(MIN_W, Math.min(maxWidth(), w));

/** Selection popup + Ask panel. Mounted once in the app shell. */
export function AskAi() {
  const { t } = useTranslation();
  const providers = useAiProviders();
  const [savedProvider, setSavedProvider] = useDefaultProvider();
  const installed = (providers.data?.providers ?? []).filter((p) => p.installed);
  const enabled = Boolean((providers.data?.ai_enabled ?? providers.data?.local_mode) && installed.length);
  const provider = installed.some((p) => p.id === savedProvider) ? savedProvider! : installed[0]?.id;

  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useStored<string | null>("openstudy.aiChat", null);
  const [ctx, setCtx] = useState<AskContext>({});
  const [page, setPage] = useState("");
  const [question, setQuestion] = useState("");
  const [images, setImages] = useState<PastedImage[]>([]);
  const [width, setWidth] = useStored("openstudy.aiWidth", DEFAULT_W);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [sidebar, setSidebar] = useStored("openstudy.aiSidebar", true);
  const [chosenModels, setChosenModels] = useStored<Record<string, string>>("openstudy.aiModels", {});
  const [popup, setPopup] = useState<{ x: number; y: number; ctx: AskContext } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const chats = useChats(open && enabled);
  const send = useSendMessage((id) => setActiveId(id));
  const chat = useChat(open ? activeId : null, send.isPending);
  const models = useModels(open && enabled);
  const renameChat = useRenameChat();
  const deleteChat = useDeleteChat();

  const messages = chat.data?.messages ?? [];
  const modelOptions = (provider && models.data?.[provider]) || [];
  const model =
    provider && modelOptions.some((m) => m.id === chosenModels[provider]) ? chosenModels[provider] : "";

  // The open chat was deleted (by you or the other person): back to a new one.
  useEffect(() => {
    if (activeId && chat.error) setActiveId(null);
  }, [activeId, chat.error, setActiveId]);

  // Open from askAi(): a selection or file starts a new chat about it.
  const resetSend = send.reset;
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<AskContext>).detail;
      if (detail.selection || detail.path) {
        setCtx(detail);
        setActiveId(null);
        setPage(detail.page ? String(detail.page) : "");
        resetSend();
      }
      setOpen(true);
      setPopup(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener(ASK_EVENT, h);
    return () => window.removeEventListener(ASK_EVENT, h);
  }, [resetSend, setActiveId]);

  // Keep the newest message in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, send.isPending, activeId, open]);

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
      // Capture context now (incl. the PDF page the selection is on); clicking may clear it.
      setPopup({ x: Math.min(r.left + r.width / 2, window.innerWidth - 60), y: r.bottom + 8, ctx: currentContext() });
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

  if (!enabled || !provider) return null;
  const currentProvider: ProviderId = provider;

  async function addImages(files: Blob[]) {
    let count = images.length;
    for (const f of files) {
      if (count >= 6) {
        toast.error(t("ai.tooManyImages"));
        return;
      }
      try {
        const img = await prepareImage(f);
        count += 1;
        setImages((cur) => [...cur, img]);
      } catch (err) {
        toast.error(t("ai.imageFailed", { msg: (err as Error).message }));
      }
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  }

  function sendNow() {
    const q = question.trim();
    if (!q || send.isPending) return;
    const pdf = ctx.path?.toLowerCase().endsWith(".pdf");
    send.mutate(
      {
        chatId: activeId,
        provider: currentProvider,
        model,
        question: q,
        selection: ctx.selection,
        path: ctx.path,
        page: pdf && Number(page) > 0 ? Number(page) : undefined,
        images,
      },
      {
        onSuccess: () => {
          setCtx({});
          setImages([]);
        },
        onError: () => setQuestion(q),
      }
    );
    setQuestion("");
  }

  function newChat() {
    setActiveId(null);
    setCtx({});
    setImages([]);
    send.reset();
    if (window.innerWidth < 640) setSidebar(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => setLiveWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth(clampWidth(window.innerWidth - ev.clientX));
      setLiveWidth(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const panelWidth = clampWidth(liveWidth ?? width);
  const wide = panelWidth >= 640;
  const isPdf = ctx.path?.toLowerCase().endsWith(".pdf");
  const sending = send.isPending ? send.variables : undefined;
  const last = messages[messages.length - 1];
  // Polling may already show our question before the answer arrives.
  const showOptimistic = sending && !(last?.role === "user" && last.content === sending.question);
  const othersPending = chat.data?.pending && !send.isPending;

  return (
    <>
      {popup && (
        <button
          type="button"
          data-ask-popup
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => askAi(popup.ctx)}
          style={{ left: popup.x, top: popup.y }}
          className="fixed z-[70] -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface px-3 py-1.5 text-xs font-medium shadow-lg hover:bg-surface-2"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("ai.ask")}
        </button>
      )}

      {!open && (
        <button
          type="button"
          aria-label={t("ai.ask")}
          title={t("ai.ask")}
          // Keep the text selection alive so it's sent along.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => askAi(currentContext())}
          className="fixed z-[60] right-4 bottom-24 md:bottom-6 h-12 w-12 inline-flex items-center justify-center rounded-full bg-fg text-bg shadow-lg hover:scale-105 transition-transform"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("ai.ask")}
          style={{ "--ai-w": `${panelWidth}px` } as React.CSSProperties}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              void addImages(files);
            }
          }}
          className="fixed z-[60] inset-x-0 bottom-0 h-[88dvh] sm:inset-auto sm:right-0 sm:top-0 sm:h-[100dvh] sm:w-[var(--ai-w)] flex bg-surface text-fg border-t sm:border-t-0 sm:border-l border-border/60 shadow-2xl"
        >
          {/* Drag the left edge to make the panel wider or narrower; double-click resets. */}
          <div
            onPointerDown={startResize}
            onDoubleClick={() => setWidth(DEFAULT_W)}
            title={t("ai.resize")}
            className="hidden sm:block absolute left-0 top-0 h-full w-2 -translate-x-1/2 cursor-col-resize z-20 hover:bg-info/40 active:bg-info/60"
          />

          {sidebar && (
            <aside
              className={cn(
                "flex flex-col border-r border-border/60 bg-surface",
                wide ? "w-56 shrink-0" : "absolute inset-y-0 left-0 z-10 w-64 max-w-[85%] shadow-xl"
              )}
            >
              <div className="flex items-center gap-2 px-3 py-3 border-b border-border/60">
                <span className="text-sm font-semibold flex-1">{t("ai.chats")}</span>
                <button
                  type="button"
                  onClick={() => setSidebar(false)}
                  aria-label={t("ai.toggleSidebar")}
                  className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={newChat}
                className="mx-3 mt-3 mb-2 inline-flex items-center gap-2 rounded-md border border-border/60 bg-surface-2 hover:bg-surface-3 px-3 py-2 text-sm font-medium"
              >
                <Plus className="h-4 w-4" />
                {t("ai.newChat")}
              </button>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
                {chats.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted m-3" />}
                {chats.data?.length === 0 && <p className="px-2 py-3 text-xs text-muted">{t("ai.noChats")}</p>}
                {chats.data?.map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "group flex items-start gap-1 rounded-md px-2 py-2 cursor-pointer",
                      c.id === activeId ? "bg-surface-2" : "hover:bg-surface-2/60"
                    )}
                    onClick={() => {
                      setActiveId(c.id);
                      setCtx({});
                      send.reset();
                      if (!wide) setSidebar(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.currentTarget as HTMLElement).click();
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{c.title || t("ai.untitled")}</div>
                      <div className="text-[11px] text-muted truncate">
                        {[c.created_by_name, fmtDateShort(c.updated_at)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={t("ai.rename")}
                      title={t("ai.rename")}
                      onClick={(e) => {
                        e.stopPropagation();
                        const title = window.prompt(t("ai.renamePrompt"), c.title);
                        if (title?.trim()) renameChat.mutate({ id: c.id, title: title.trim() });
                      }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-muted hover:text-fg"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("ai.delete")}
                      title={t("ai.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!window.confirm(t("ai.deleteConfirm", { title: c.title || t("ai.untitled") }))) return;
                        deleteChat.mutate(c.id);
                        if (c.id === activeId) newChat();
                      }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-muted hover:text-critical"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </aside>
          )}

          <section className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-3">
              {!sidebar && (
                <button
                  type="button"
                  onClick={() => setSidebar(true)}
                  aria-label={t("ai.toggleSidebar")}
                  title={t("ai.chats")}
                  className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              )}
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="text-sm font-semibold flex-1 truncate">
                {(activeId && chat.data?.title) || t("ai.newChat")}
              </span>
              <button
                type="button"
                onClick={newChat}
                aria-label={t("ai.newChat")}
                title={t("ai.newChat")}
                className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-5">
              {!activeId && !sending && <p className="text-sm text-muted">{t("ai.emptyChat")}</p>}
              {activeId && chat.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
              {messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
              {showOptimistic && sending && (
                <Message
                  m={{
                    id: -1,
                    role: "user",
                    content: sending.question,
                    provider: sending.provider,
                    model: sending.model,
                    context: null,
                    created_at: "",
                    author_name: null,
                    images: [],
                  }}
                  localImages={sending.images}
                />
              )}
              {sending && (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("ai.thinking", { name: PROVIDER_LABELS[sending.provider] })}
                </p>
              )}
              {othersPending && (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("ai.waitingForOther")}
                </p>
              )}
              {send.error && <p className="text-sm text-critical">{(send.error as Error).message}</p>}
              <div ref={endRef} />
            </div>

            <div className="border-t border-border/60 p-3 flex flex-col gap-2">
              {(ctx.path || ctx.selection) && (
                <div className="flex flex-col gap-1.5 text-xs text-muted">
                  {ctx.path && (
                    <div className="flex items-center gap-2">
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
                      <button
                        type="button"
                        onClick={() => setCtx({})}
                        aria-label={t("ai.removeContext")}
                        title={t("ai.removeContext")}
                        className="p-0.5 hover:text-fg"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {ctx.selection && (
                    <blockquote className="border-l-2 border-border pl-2 line-clamp-3 whitespace-pre-wrap">
                      {ctx.selection}
                    </blockquote>
                  )}
                </div>
              )}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {images.map((img, i) => (
                    <div key={img.url} className="relative">
                      <img src={img.url} alt="" className="h-16 w-16 rounded-md object-cover border border-border/60" />
                      <button
                        type="button"
                        aria-label={t("ai.removeImage")}
                        onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-fg text-bg inline-flex items-center justify-center"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendNow();
                  }
                }}
                rows={3}
                placeholder={t("ai.placeholder")}
                className="w-full resize-none rounded-md border border-border/60 bg-surface-2 px-3 py-2 text-[15px]"
              />
              <div className="flex items-center gap-2">
                <select
                  value={currentProvider}
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
                <select
                  value={model}
                  onChange={(e) => setChosenModels({ ...chosenModels, [currentProvider]: e.target.value })}
                  aria-label={t("ai.model")}
                  disabled={modelOptions.length <= 1}
                  className="min-w-0 flex-1 max-w-[16rem] rounded-md border border-border/60 bg-surface-2 px-2 py-1 text-sm disabled:opacity-60"
                >
                  {(modelOptions.length ? modelOptions : [{ id: "", label: "" }]).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id ? m.label : t("ai.modelDefault")}
                    </option>
                  ))}
                </select>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label={t("ai.attach")}
                  title={t("ai.attach")}
                  className="touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void addImages(files);
                  }}
                />
                <button
                  type="button"
                  onClick={sendNow}
                  disabled={!question.trim() || send.isPending}
                  aria-label={t("ai.send")}
                  className="touch-target inline-flex items-center justify-center rounded-md bg-fg text-bg px-3 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Message({ m, localImages }: { m: ChatMessage; localImages?: PastedImage[] }) {
  const { t } = useTranslation();
  if (m.role === "user") {
    const ctx = m.context;
    return (
      <div className="flex flex-col gap-1.5 items-end">
        <span className="text-[11px] text-muted">{m.author_name ?? t("ai.you")}</span>
        {ctx?.path && (
          <span className="text-[11px] text-muted truncate max-w-full">
            {t("ai.file", { name: ctx.path.split("/").pop() })}
            {ctx.page ? ` · ${t("ai.page")} ${ctx.page}` : ""}
          </span>
        )}
        {ctx?.selection && (
          <blockquote className="max-w-[90%] border-r-2 border-border pr-2 text-xs text-muted line-clamp-3 whitespace-pre-wrap text-right">
            {ctx.selection}
          </blockquote>
        )}
        {(m.images.length > 0 || (localImages?.length ?? 0) > 0) && (
          <div className="flex flex-wrap justify-end gap-2">
            {m.images.map((id) => (
              <a key={id} href={`/api/ai/images/${id}`} target="_blank" rel="noopener noreferrer">
                <img
                  src={`/api/ai/images/${id}`}
                  alt=""
                  className="max-h-40 max-w-[12rem] rounded-md border border-border/60 object-contain"
                />
              </a>
            ))}
            {localImages?.map((img) => (
              <img
                key={img.url}
                src={img.url}
                alt=""
                className="max-h-40 max-w-[12rem] rounded-md border border-border/60 object-contain opacity-70"
              />
            ))}
          </div>
        )}
        <div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-surface-2 px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.role === "error") {
    return <p className="text-sm text-critical whitespace-pre-wrap">{m.content}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">
        {m.provider ? PROVIDER_LABELS[m.provider] : "AI"}
        {m.model ? ` · ${m.model}` : ""}
      </span>
      <Markdown text={m.content} />
    </div>
  );
}
