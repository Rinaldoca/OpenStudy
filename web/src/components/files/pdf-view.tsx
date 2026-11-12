import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Camera,
  Download,
  Eraser,
  FilePlus2,
  Highlighter,
  ImageDown,
  ImagePlus,
  LassoSelect,
  Loader2,
  PenLine,
  TextCursor,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { API_BASE, api, apiFetch } from "@/lib/api";
import { setOpenPage } from "@/lib/ai";
import { cn } from "@/lib/cn";

/* PDF viewer + notes (GoodNotes-style). pdf.js draws each page on a canvas
 * with a transparent text layer (selectable, for Ask AI); an SVG overlay on
 * top holds the user's ink, images and text. Notes are saved per user via
 * /api/notes (never into the PDF); Export flattens them into a copy.
 * Coordinates are PDF points, origin top-left — see app/routers/notes.py. */

type PdfJs = typeof import("pdfjs-dist");
type Stroke = { id?: string; c: string; w: number; hl?: boolean; pts: number[] };
type Item =
  | { id?: string; t: "img"; src: string; x: number; y: number; w: number; h: number }
  // w/h: the text box (wraps at w). Notes saved before boxes existed have neither.
  | { id?: string; t: "text"; text: string; x: number; y: number; w?: number; h?: number; size: number; c: string };
type Active = { slot: string; i: number; editing?: boolean } | null;
type PageNotes = { strokes?: Stroke[]; items?: Item[] };
type Notes = { layout?: string[]; pages: Record<string, PageNotes> };
type Tool = "select" | "pen" | "hl" | "eraser" | "text" | "lasso";

// prettier-ignore
const PEN_COLORS = [
  "#111827", "#6b7280", "#ffffff", "#dc2626", "#ea580c", "#ca8a04",
  "#16a34a", "#0d9488", "#0284c7", "#2563eb", "#7c3aed", "#db2777", "#92400e",
];
const HL_COLORS = ["#facc15", "#fb923c", "#4ade80", "#22d3ee", "#60a5fa", "#c084fc", "#f472b6"];
const PEN_WIDTH = 1.8;
const HL_WIDTH = 14;
const ERASE_RADIUS = 8;
const pageNumber = (slot: string) => (/^p\d+$/.test(slot) ? Number(slot.slice(1)) : null);
const round = (v: number) => Math.round(v * 10) / 10;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
const MAX_CANVAS_PIXELS = 16_000_000; // per page; keeps memory sane at high zoom

export function PdfView({ url, path }: { url: string; path: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 }); // page 1, points
  const [fit, setFit] = useState(1); // scale that fits the page width
  const [zoom, setZoom] = useState(1); // user zoom on top of `fit`
  const scale = fit * zoom;
  const zoomRef = useRef(1);
  const anchor = useRef<{ fx: number; fy: number; sx: number; sy: number; ratio: number } | null>(null);
  const [pageLabel, setPageLabel] = useState("");
  const [failed, setFailed] = useState(false);

  // Notes are shared with everyone who can open this file (see app/routers/notes.py).
  // `base` is the server's copy at `version`; `pending` are my changes not yet sent.
  // What's shown = base + pending. Others' changes arrive by polling.
  const [notes, setNotes] = useState<Notes | null>(null);
  const notesRef = useRef<Notes | null>(null);
  const base = useRef<Notes | null>(null);
  const version = useRef(0);
  const pending = useRef<Op[]>([]);
  const inflight = useRef(false);
  const history = useRef<Op[][]>([]); // per step: the ops that revert one of *my* changes
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const defaultLayout = useRef<string[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");

  const [tool, setTool] = useState<Tool>("select");
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [hlColor, setHlColor] = useState(HL_COLORS[0]);
  const currentSlot = useRef("p1");
  const fileInput = useRef<HTMLInputElement>(null);

  // ── Load the PDF ──
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PdfJs["getDocument"]> | undefined;
    (async () => {
      const lib = await import("pdfjs-dist"); // own chunk: only loaded when a PDF opens
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      task = lib.getDocument({ url, withCredentials: true });
      const d = await task.promise;
      if (cancelled) return;
      const vp = (await d.getPage(1)).getViewport({ scale: 1 });
      setSize({ w: vp.width, h: vp.height });
      setPdfjs(lib);
      setDoc(d);
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      void task?.destroy();
      setOpenPage(null);
    };
  }, [url]);

  // ── Shared notes: load, send my changes, pick up others' ──
  const show = useCallback((n: Notes) => {
    notesRef.current = n;
    setNotes(n);
  }, []);

  useEffect(() => {
    let cancelled = false;
    base.current = null;
    pending.current = [];
    history.current = [];
    api
      .get<{ version: number; data: Notes }>("/api/notes", { path })
      .then((r) => {
        if (cancelled) return;
        base.current = r.data;
        version.current = r.version;
        show(r.data);
      })
      .catch(() => {
        if (cancelled) return;
        show({ pages: {} });
        setSaveState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [path, show]);

  const flushRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback(() => {
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flushRef.current(), 400);
  }, []);
  useEffect(() => {
    flushRef.current = async () => {
      if (inflight.current || !pending.current.length || !base.current) return;
      inflight.current = true;
      setSaveState("saving");
      const sent = pending.current;
      pending.current = [];
      try {
        const r = await apiFetch<{ version: number; data?: Notes }>("/api/notes/ops", {
          method: "POST",
          body: { path, base: version.current, ops: sent },
        });
        version.current = r.version;
        if (r.data) {
          // Someone else changed it meanwhile: rebuild from the server's copy + my unsent changes.
          base.current = r.data;
          show(reuseUnchanged(applyOps(r.data, pending.current), notesRef.current));
        } else {
          base.current = applyOps(base.current, sent);
        }
        setSaveState(pending.current.length ? "saving" : "saved");
      } catch {
        pending.current = [...sent, ...pending.current]; // retry with the next change / tick
        setSaveState("error");
      } finally {
        inflight.current = false;
        if (pending.current.length) schedule();
      }
    };
  }, [path, show, schedule]);
  useEffect(() => () => void flushRef.current(), []); // send what's left when the viewer closes

  // Poll for the other person's changes (every 3 s while visible and idle).
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || inflight.current || pending.current.length || !base.current) return;
      try {
        const r = await api.get<{ version: number; data?: Notes }>("/api/notes", { path, since: version.current });
        if (!r.data || r.version === version.current || inflight.current || pending.current.length) return;
        version.current = r.version;
        base.current = r.data;
        show(reuseUnchanged(r.data, notesRef.current));
      } catch {
        /* offline for a moment; next tick retries */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [path, show]);

  const update = useCallback(
    (fn: (n: Notes) => Notes) => {
      const prev = notesRef.current;
      if (!prev) return;
      const next = withIds(fn(prev));
      const ops = diffNotes(prev, next, defaultLayout.current);
      if (!ops.length) return;
      history.current.push(diffNotes(next, prev, defaultLayout.current));
      if (history.current.length > 100) history.current.shift();
      pending.current.push(...ops);
      show(next);
      schedule();
    },
    [show, schedule]
  );
  // The selected image/text box (one at a time, across pages); `editing` = typing in it.
  const [active, setActive] = useState<Active>(null);
  const activeRef = useRef<Active>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Undo reverts only my own last change — never the other person's.
  const undo = useCallback(() => {
    const inv = history.current.pop();
    if (!inv || !notesRef.current) return;
    setActive(null); // indices may no longer match
    pending.current.push(...inv);
    show(applyOps(notesRef.current, inv));
    schedule();
  }, [show, schedule]);

  const numPages = doc?.numPages ?? 0;
  useEffect(() => {
    defaultLayout.current = Array.from({ length: numPages }, (_, i) => `p${i + 1}`);
  }, [numPages]);
  const layoutOf = useCallback(
    (n: Notes) => n.layout ?? Array.from({ length: numPages }, (_, i) => `p${i + 1}`),
    [numPages]
  );
  const layout = notes ? layoutOf(notes) : [];

  const updatePage = useCallback(
    (slot: string, fn: (p: PageNotes) => PageNotes) =>
      update((n) => ({ ...n, pages: { ...n.pages, [slot]: fn(n.pages[slot] ?? {}) } })),
    [update]
  );

  function addPage() {
    const slot = `b:${Math.random().toString(36).slice(2, 8)}`;
    update((n) => {
      const l = [...layoutOf(n)];
      l.splice(l.indexOf(currentSlot.current) + 1, 0, slot);
      return { ...n, layout: l };
    });
    setTimeout(() => scrollerRef.current?.querySelector(`[data-slot="${slot}"]`)?.scrollIntoView({ behavior: "smooth" }), 50);
  }
  function removePage(slot: string) {
    update((n) => {
      const pages = { ...n.pages };
      delete pages[slot];
      return { ...n, layout: layoutOf(n).filter((s) => s !== slot), pages };
    });
  }

  /** Add an image to `slot` (default: the page in view), centred on `at` (default: upper middle), and select it. */
  const insertImage = useCallback(
    async (file: Blob, slot = currentSlot.current, at?: [number, number]) => {
      const img = await downscale(file);
      const w = Math.min(size.w * 0.6, img.w);
      const h = (w * img.h) / img.w;
      const [cx, cy] = at ?? [size.w / 2, size.h * 0.15 + h / 2];
      const i = notesRef.current?.pages[slot]?.items?.length ?? 0;
      updatePage(slot, (p) => ({
        ...p,
        items: [...(p.items ?? []), { t: "img", src: img.src, x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h) }],
      }));
      setTool("select");
      setActive({ slot, i });
    },
    [size, updatePage]
  );

  // ── Zoom ──
  // Fit the page width to the window (re-fits when the window resizes).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !size.w) return;
    const refit = () => setFit(Math.min((scroller.clientWidth - 16) / size.w, 2));
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [size.w, doc]);

  /** Zoom to `next`, keeping the point under (clientX, clientY) — or the centre — still. */
  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const scroller = scrollerRef.current;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (!scroller || z === zoomRef.current) return;
    const r = scroller.getBoundingClientRect();
    const fx = clientX === undefined ? r.width / 2 : clientX - r.left;
    const fy = clientY === undefined ? r.height / 2 : clientY - r.top;
    anchor.current = { fx, fy, sx: scroller.scrollLeft, sy: scroller.scrollTop, ratio: z / zoomRef.current };
    zoomRef.current = z;
    setZoom(z);
  }, []);
  useLayoutEffect(() => {
    const a = anchor.current;
    const scroller = scrollerRef.current;
    if (!a || !scroller) return;
    anchor.current = null;
    scroller.scrollLeft = (a.sx + a.fx) * a.ratio - a.fx;
    scroller.scrollTop = (a.sy + a.fy) * a.ratio - a.fy;
  }, [zoom]);

  // Trackpad pinch / Ctrl+scroll (Chrome, Firefox), and pinch on Safari/iPad.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // otherwise the browser zooms the whole app
      // Trackpad pinch sends small deltas, mouse wheels big ones: cap a notch at ~25%.
      const d = Math.max(-25, Math.min(25, e.deltaY));
      zoomTo(zoomRef.current * Math.exp(-d * 0.01), e.clientX, e.clientY);
    };
    let base = 1;
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      base = zoomRef.current;
    };
    const onGesture = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      zoomTo(base * g.scale, g.clientX, g.clientY);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("gesturestart", onGestureStart);
    scroller.addEventListener("gesturechange", onGesture);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("gesturestart", onGestureStart);
      scroller.removeEventListener("gesturechange", onGesture);
    };
  }, [zoomTo, doc]);

  // Paste an image (screenshot, copied picture) onto the current page; Cmd/Ctrl+Z undo.
  useEffect(() => {
    const inField = (t: EventTarget | null) => (t as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        void insertImage(file);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const a = activeRef.current;
      if (a && !a.editing && !inField(e.target)) {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          updatePage(a.slot, (p) => ({ ...p, items: (p.items ?? []).filter((_, j) => j !== a.i) }));
          setActive(null);
          return;
        }
        if (e.key === "Escape") {
          e.stopPropagation(); // deselect instead of closing the viewer
          setActive(null);
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey) || inField(e.target)) return;
      const zoomKeys: Record<string, number> = { "=": 1.25, "+": 1.25, "-": 0.8, "0": 0 };
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key in zoomKeys) {
        e.preventDefault(); // instead of zooming the whole app
        const k = zoomKeys[e.key];
        zoomTo(k ? zoomRef.current * k : 1);
      }
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey, true); // capture: before the viewer's Escape-to-close
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [insertImage, undo, zoomTo, updatePage]);

  // Track the page in view: for "add page after", pasting, Ask AI's page and the page counter.
  const notesLoaded = notes !== null;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !doc) return;
    const onScroll = () => {
      const mid = scroller.scrollTop + scroller.clientHeight / 2;
      const els = Array.from(scroller.querySelectorAll<HTMLElement>("[data-slot]"));
      const el = els.find((p) => p.offsetTop + p.offsetHeight > mid) ?? els[els.length - 1];
      if (!el) return;
      currentSlot.current = el.dataset.slot!;
      setPageLabel(`${els.indexOf(el) + 1} / ${els.length}`);
      const n = pageNumber(el.dataset.slot!);
      if (n) setOpenPage(n);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [doc, notesLoaded, notes?.layout]);

  async function exportPdf() {
    // Make sure my latest strokes are on the server before it renders the export.
    for (let i = 0; i < 50 && (pending.current.length || inflight.current); i++) {
      void flushRef.current();
      await new Promise((r) => setTimeout(r, 100));
    }
    window.location.href = `${API_BASE}/api/notes/export?path=${encodeURIComponent(path)}`;
  }

  const color = tool === "hl" ? hlColor : penColor;
  function pickColor(c: string) {
    if (tool === "hl") return setHlColor(c);
    setPenColor(c);
    const a = active;
    if (a && notes?.pages[a.slot]?.items?.[a.i]?.t === "text") {
      updatePage(a.slot, (p) => ({ ...p, items: (p.items ?? []).map((it, j) => (j === a.i && it.t === "text" ? { ...it, c } : it)) }));
    }
  }
  const ready = doc && pdfjs && notes;

  return (
    <div className="relative h-full">
      <div ref={scrollerRef} className="h-full overflow-auto">
        {failed && <p className="p-6 text-sm text-critical">Couldn't render this PDF.</p>}
        {!ready && !failed && (
          <div className="py-10 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        )}
        {ready && (
          // w-max + min-w-full: centred when narrower than the window, scrollable sideways when zoomed in.
          <div className="w-max min-w-full flex flex-col items-center gap-3 px-2 py-3 pb-24">
            {layout.map((slot) => (
              <PdfPage
                key={slot}
                pdfjs={pdfjs}
                doc={doc}
                slot={slot}
                scale={scale}
                size={size}
                notes={notes.pages[slot]}
                tool={tool}
                color={color}
                scroller={scrollerRef}
                onChange={(fn) => updatePage(slot, fn)}
                onRemove={pageNumber(slot) ? undefined : () => removePage(slot)}
                active={active?.slot === slot ? active : null}
                setActive={(i, editing) => setActive(i === null ? null : { slot, i, editing })}
                onDropImage={(file, at) => void insertImage(file, slot, at)}
              />
            ))}
          </div>
        )}
      </div>

      {ready && (
        <div className="absolute top-3 right-4 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-surface/95 px-1 py-1 shadow-lg text-xs">
          <ToolButton label="Zoom out (⌘−)" onClick={() => zoomTo(zoom * 0.8)} icon={ZoomOut} />
          <button
            type="button"
            title="Fit width (⌘0)"
            onClick={() => zoomTo(1)}
            className="min-w-[3.25rem] h-9 rounded-full tabular-nums text-muted hover:text-fg hover:bg-surface-2"
          >
            {Math.round(zoom * 100)}%
          </button>
          <ToolButton label="Zoom in (⌘+)" onClick={() => zoomTo(zoom * 1.25)} icon={ZoomIn} />
          {pageLabel && <span className="px-2 tabular-nums text-muted">{pageLabel}</span>}
        </div>
      )}

      {ready && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5 max-w-[calc(100%-5.5rem)]">
          {(tool === "pen" || tool === "hl" || tool === "text" || (active && notes?.pages[active.slot]?.items?.[active.i]?.t === "text")) && (
            <div className="flex flex-wrap justify-center gap-1.5 rounded-2xl border border-border/60 bg-surface px-2 py-1.5 shadow-lg">
              {(tool === "hl" ? HL_COLORS : PEN_COLORS).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => pickColor(c)}
                  className={cn("h-6 w-6 rounded-full border-2 ring-1 ring-white/30", color === c ? "border-fg" : "border-transparent")}
                  style={{ background: c }}
                />
              ))}
              <CustomColor
                value={color}
                active={!(tool === "hl" ? HL_COLORS : PEN_COLORS).includes(color)}
                onChange={pickColor}
              />
            </div>
          )}
          <div className="flex items-center gap-0.5 overflow-x-auto rounded-full border border-border/60 bg-surface px-1.5 py-1 shadow-lg">
            <ToolButton label="Select text" active={tool === "select"} onClick={() => setTool("select")} icon={TextCursor} />
            <ToolButton label="Pen" active={tool === "pen"} onClick={() => setTool("pen")} icon={PenLine} />
            <ToolButton label="Highlighter" active={tool === "hl"} onClick={() => setTool("hl")} icon={Highlighter} />
            <ToolButton label="Eraser" active={tool === "eraser"} onClick={() => setTool("eraser")} icon={Eraser} />
            <ToolButton label="Lasso: circle notes to move, recolour or delete them" active={tool === "lasso"} onClick={() => setTool("lasso")} icon={LassoSelect} />
            <ToolButton label="Text box" active={tool === "text"} onClick={() => setTool("text")} icon={Type} />
            <ToolButton label="Insert image (or paste one)" onClick={() => fileInput.current?.click()} icon={ImagePlus} />
            <ToolButton label="Add blank page after this one" onClick={addPage} icon={FilePlus2} />
            <span className="mx-1 h-5 w-px bg-border/60" />
            <ToolButton label="Undo" onClick={undo} icon={Undo2} />
            <ToolButton label="Export PDF with notes" onClick={() => void exportPdf()} icon={Download} />
            <span
              title={saveState === "error" ? "Couldn't sync — retrying" : saveState === "saving" ? "Syncing…" : "Synced — shared with everyone who has this file"}
              className={cn(
                "mx-1.5 h-2 w-2 shrink-0 rounded-full",
                saveState === "saved" ? "bg-ok" : saveState === "saving" ? "bg-muted animate-pulse" : "bg-critical"
              )}
            />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void insertImage(f);
            }}
          />
        </div>
      )}
    </div>
  );
}

function ToolButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-colors",
        active ? "bg-fg text-bg" : "text-muted hover:text-fg hover:bg-surface-2"
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

type Corner = "nw" | "ne" | "sw" | "se";
type Drag = { i: number; mode: "move" | Corner; x0: number; y0: number; dx: number; dy: number };

/** One page: canvas + text layer (original pages) or blank paper, plus the notes overlay. */
function PdfPage({
  pdfjs,
  doc,
  slot,
  scale,
  size,
  notes,
  tool,
  color,
  scroller,
  onChange,
  onRemove,
  active,
  setActive,
  onDropImage,
}: {
  pdfjs: PdfJs;
  doc: PDFDocumentProxy;
  slot: string;
  scale: number;
  size: { w: number; h: number };
  notes?: PageNotes;
  tool: Tool;
  color: string;
  scroller: React.RefObject<HTMLDivElement | null>;
  onChange: (fn: (p: PageNotes) => PageNotes) => void;
  onRemove?: () => void;
  active: Active;
  setActive: (i: number | null, editing?: boolean) => void;
  onDropImage: (file: File, at: [number, number]) => void;
}) {
  const n = pageNumber(slot);
  const ref = useRef<HTMLDivElement>(null);
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(false);
  // Pages resize instantly while zooming (CSS); the sharp re-render waits until zooming pauses.
  const [renderScale, setRenderScale] = useState(scale);
  useEffect(() => {
    const t = setTimeout(() => setRenderScale(scale), 200);
    return () => clearTimeout(t);
  }, [scale]);
  const [pageSize, setPageSize] = useState(size);
  const [draft, setDraft] = useState<number[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [boxDraft, setBoxDraft] = useState<number[] | null>(null); // text box being dragged out
  const erasing = useRef(false);
  const pan = useRef<{ id: number; x: number; y: number } | null>(null); // a finger scrolling (pencil-only mode)
  // Lasso: the loop being drawn, the selected strokes/items (by identity, so an
  // undo that swaps them out simply empties the selection), and a pending move.
  const [lasso, setLasso] = useState<number[] | null>(null);
  const [picked, setPicked] = useState<Set<Stroke | Item>>(new Set());
  const [moveSel, setMoveSel] = useState<{ x0: number; y0: number; dx: number; dy: number } | null>(null);
  const selStrokes = tool === "lasso" ? (notes?.strokes ?? []).filter((x) => picked.has(x)) : [];
  const selItems = tool === "lasso" ? (notes?.items ?? []).filter((x) => picked.has(x)) : [];
  const hasSel = selStrokes.length + selItems.length > 0;
  const selBox = hasSel ? boundsOf(selStrokes, selItems) : null;
  // The lasso loop's bounding box: what a screenshot captures (even if no notes were picked).
  const [loopBox, setLoopBox] = useState<Box | null>(null);
  const area = tool === "lasso" ? (loopBox ?? selBox) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), {
      root: scroller.current,
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!visible || !n) return;
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    (async () => {
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      if (cancelled) return;
      setPageSize({ w: vp1.width, h: vp1.height });
      const viewport = page.getViewport({ scale: renderScale });
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      // Render off-screen, then swap in: no white flash while re-rendering at a new zoom.
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      task = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      await task.promise;
      if (cancelled || !textRef.current || !canvasHolder.current) return;
      canvasHolder.current.replaceChildren(canvas);
      textRef.current.replaceChildren();
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport }).render();
    })().catch(() => {}); // cancelled renders reject; nothing to do
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, n, doc, pdfjs, renderScale]);

  const toPt = (e: React.PointerEvent | PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [round((e.clientX - r.left) / scale), round((e.clientY - r.top) / scale)];
  };

  function eraseAt([x, y]: number[]) {
    const r2 = ERASE_RADIUS * ERASE_RADIUS;
    // Distance to each segment, not just the sampled points: fast strokes are sparse.
    const hitStroke = (s: Stroke) => {
      const reach = r2 + (s.w / 2) ** 2;
      for (let i = 0; i < s.pts.length - 1; i += 2) {
        const [ax, ay] = [s.pts[i], s.pts[i + 1]];
        const [bx, by] = i + 3 < s.pts.length ? [s.pts[i + 2], s.pts[i + 3]] : [ax, ay];
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
        if ((ax + t * (bx - ax) - x) ** 2 + (ay + t * (by - ay) - y) ** 2 <= reach) return true;
      }
      return false;
    };
    const hitItem = (it: Item) => {
      const b = itemBox(it);
      return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    };
    if (notes?.strokes?.some(hitStroke) || notes?.items?.some(hitItem)) {
      onChange((p) => ({
        ...p,
        strokes: (p.strokes ?? []).filter((s) => !hitStroke(s)),
        items: (p.items ?? []).filter((it) => !hitItem(it)),
      }));
    }
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "pen") notePencil();
    else if (e.pointerType === "touch" && pencilOnly()) {
      // Apple Pencil draws; a finger scrolls (two fingers still pinch-zoom).
      if (!pan.current) {
        svgRef.current!.setPointerCapture(e.pointerId);
        pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      return;
    }
    const pt = toPt(e);
    if (tool === "lasso") {
      svgRef.current!.setPointerCapture(e.pointerId);
      const b = selBox;
      if (b && pt[0] >= b.x - 6 && pt[0] <= b.x + b.w + 6 && pt[1] >= b.y - 6 && pt[1] <= b.y + b.h + 6) {
        setMoveSel({ x0: pt[0], y0: pt[1], dx: 0, dy: 0 }); // drag the selection
      } else {
        setPicked(new Set());
        setLoopBox(null);
        setLasso(pt);
      }
    } else if (tool === "pen" || tool === "hl") {
      svgRef.current!.setPointerCapture(e.pointerId);
      setDraft(pt);
    } else if (tool === "eraser") {
      svgRef.current!.setPointerCapture(e.pointerId);
      erasing.current = true;
      eraseAt(pt);
    } else if (tool === "text") {
      // Drag out a text box (or click for a default-sized one); typing starts right away.
      svgRef.current!.setPointerCapture(e.pointerId);
      setActive(null);
      setBoxDraft([pt[0], pt[1], pt[0], pt[1]]);
    }
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pan.current) {
      if (e.pointerId !== pan.current.id) return;
      scroller.current?.scrollBy(pan.current.x - e.clientX, pan.current.y - e.clientY);
      pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType === "touch" && pencilOnly()) return; // a second finger while drawing
    if (boxDraft) {
      const [x, y] = toPt(e);
      setBoxDraft([boxDraft[0], boxDraft[1], x, y]);
    } else if (lasso) {
      setLasso((l) => (l ? [...l, ...toPt(e)] : l));
    } else if (moveSel) {
      const [x, y] = toPt(e);
      setMoveSel({ ...moveSel, dx: x - moveSel.x0, dy: y - moveSel.y0 });
    } else if (draft) {
      const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      setDraft((d) => (d ? [...d, ...evs.flatMap((ev) => toPt(ev))] : d));
    } else if (erasing.current) {
      eraseAt(toPt(e));
    }
  }
  function onPointerUp(e?: React.PointerEvent<SVGSVGElement>) {
    if (pan.current) {
      if (!e || e.pointerId === pan.current.id) pan.current = null;
      return;
    }
    erasing.current = false;
    if (boxDraft) {
      const [x0, y0, x1, y1] = boxDraft;
      setBoxDraft(null);
      const dragged = Math.abs(x1 - x0) > 12;
      const box = dragged
        ? { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.max(Math.abs(y1 - y0), 20) }
        : { x: x0, y: y0, w: Math.min(220, w - x0 - 8), h: 22 };
      const i = notes?.items?.length ?? 0;
      onChange((p) => ({ ...p, items: [...(p.items ?? []), { t: "text", text: "", ...mapRound(box), size: 14, c: color }] }));
      setActive(i, true);
      return;
    }
    if (lasso) {
      // A stroke is picked when most of it is inside the loop; an item when its centre is.
      const inside = (x: number, y: number) => pointInPolygon(x, y, lasso);
      const next = new Set<Stroke | Item>();
      for (const st of notes?.strokes ?? []) {
        let hits = 0;
        for (let i = 0; i < st.pts.length - 1; i += 2) if (inside(st.pts[i], st.pts[i + 1])) hits++;
        if (hits * 2 >= st.pts.length / 2) next.add(st);
      }
      for (const it of notes?.items ?? []) {
        const b = itemBox(it);
        if (inside(b.x + b.w / 2, b.y + b.h / 2)) next.add(it);
      }
      setPicked(next);
      setLasso(null);
      const loop = boundsOf([{ c: "", w: 0, pts: lasso }], []);
      setLoopBox(loop.w > 4 && loop.h > 4 ? loop : null); // a tap isn't an area
      return;
    }
    if (moveSel) {
      const { dx, dy } = moveSel;
      setMoveSel(null);
      setLoopBox(null); // the notes moved away from the loop; screenshots follow them
      if (Math.abs(dx) + Math.abs(dy) >= 1) editSelection((st) => ({ ...st, pts: st.pts.map((v, i) => round(v + (i % 2 ? dy : dx))) }), (it) => ({ ...it, x: round(it.x + dx), y: round(it.y + dy) }));
      return;
    }
    if (!draft) return;
    const stroke: Stroke = { c: color, w: tool === "hl" ? HL_WIDTH : PEN_WIDTH, pts: draft };
    if (tool === "hl") stroke.hl = true;
    onChange((p) => ({ ...p, strokes: [...(p.strokes ?? []), stroke] }));
    setDraft(null);
  }

  /** Replace the selected strokes/items (move, recolour) and keep them selected; null deletes. */
  function editSelection(fs: (s: Stroke) => Stroke | null, fi: (it: Item) => Item | null) {
    const next = new Set<Stroke | Item>();
    const keep = <T extends Stroke | Item>(x: T, f: (x: T) => T | null): T[] => {
      if (!picked.has(x)) return [x];
      const y = f(x);
      if (y) next.add(y);
      return y ? [y] : [];
    };
    const strokes = (notes?.strokes ?? []).flatMap((x) => keep(x, fs));
    const items = (notes?.items ?? []).flatMap((x) => keep(x, fi));
    onChange((p) => ({ ...p, strokes, items }));
    setPicked(next);
  }
  const deleteSelection = () => editSelection(() => null, () => null);

  const deleteSelectionRef = useRef(deleteSelection);
  useEffect(() => {
    deleteSelectionRef.current = deleteSelection;
  });

  // Backspace/Delete removes the selection, Escape clears it (and the screenshot area).
  const hasArea = !!area;
  useEffect(() => {
    if (!hasSel && !hasArea) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) return;
      if ((e.key === "Backspace" || e.key === "Delete") && hasSel) {
        e.preventDefault();
        deleteSelectionRef.current();
      } else if (e.key === "Escape") {
        e.stopPropagation(); // don't close the viewer
        setPicked(new Set());
        setLoopBox(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hasSel, hasArea]);

  /** Render `r` (points) to a PNG: the PDF page re-rendered sharp at ~216 dpi, notes on top. */
  async function snapshot(r: Box): Promise<Blob> {
    const k = Math.min(3, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, r.w * r.h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(r.w * k));
    canvas.height = Math.max(1, Math.round(r.h * k));
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (n) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: k, offsetX: -r.x * k, offsetY: -r.y * k });
      await page.render({ canvas, viewport }).promise;
    }
    g.setTransform(k, 0, 0, k, -r.x * k, -r.y * k); // draw notes in page points
    await drawNotes(g, notes);
    return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("render failed"))), "image/png"));
  }
  function copyShot(r: Box) {
    const png = snapshot(r);
    // Pass the promise (not the blob) so the click still counts as the user's gesture.
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .then(() => toast.success("Screenshot copied — paste it anywhere (⌘V)"))
      .catch(async () => {
        saveBlob(await png, `page-${n ?? "blank"}.png`); // no clipboard access: download instead
        toast.message("Couldn't copy — saved the screenshot instead");
      });
  }
  async function saveShot(r: Box) {
    saveBlob(await snapshot(r), `page-${n ?? "blank"}.png`);
  }

  // Select, move and resize images and text boxes (select + text tools).
  function itemDown(e: React.PointerEvent, i: number, mode: Drag["mode"]) {
    e.stopPropagation();
    const it = notes?.items?.[i];
    if (active?.editing && active.i === i) return; // clicks inside the textarea are for the cursor
    if (mode === "move" && it?.t === "text" && (tool === "text" || active?.i === i)) {
      setActive(i, true); // text tool, or a second click: start typing
      return;
    }
    setActive(i);
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x0, y0] = toPt(e);
    setDrag({ i, mode, x0, y0, dx: 0, dy: 0 });
  }
  function itemMove(e: React.PointerEvent) {
    if (!drag) return;
    const [x, y] = toPt(e);
    setDrag({ ...drag, dx: x - drag.x0, dy: y - drag.y0 });
  }
  function itemUp() {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (Math.abs(d.dx) + Math.abs(d.dy) < 1) return;
    onChange((p) => ({ ...p, items: (p.items ?? []).map((it, i) => (i === d.i ? applyDrag(it, d) : it)) }));
  }
  /** Save what was typed; an empty box disappears. Grows the box to fit the text. */
  function commitText(i: number, text: string, contentHeight: number) {
    setActive(i);
    onChange((p) => ({
      ...p,
      items: (p.items ?? []).flatMap((it, j) => {
        if (j !== i || it.t !== "text") return [it];
        return text.trim() ? [{ ...it, text, h: round(Math.max(it.h ?? 0, contentHeight)) }] : [];
      }),
    }));
    if (!text.trim()) setActive(null);
  }
  function setItem(i: number, fn: (it: Item) => Item | null) {
    onChange((p) => ({ ...p, items: (p.items ?? []).flatMap((it, j) => (j !== i ? [it] : (fn(it) ?? []))) }));
  }

  const drawing = tool !== "select";
  const itemsInteractive = tool === "select" || tool === "text";
  const w = n ? pageSize.w : size.w;
  const h = n ? pageSize.h : size.h;

  return (
    <div
      ref={ref}
      data-slot={slot}
      data-pdf-page={n ?? undefined}
      className="pdf-page group"
      style={{ width: w * scale, height: h * scale, "--total-scale-factor": scale } as React.CSSProperties}
      onPointerDown={() => active && !active.editing && setActive(null)} // items stop propagation
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (!file) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDropImage(file, [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]);
      }}
    >
      {n && visible && (
        <>
          <div ref={canvasHolder} className="absolute inset-0" />
          <div ref={textRef} className="textLayer" />
        </>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        className="absolute inset-0 h-full w-full select-none"
        style={{
          zIndex: 2,
          pointerEvents: drawing ? "auto" : "none",
          touchAction: drawing ? "none" : "auto",
          cursor: tool === "eraser" ? "cell" : tool === "text" ? "text" : moveSel ? "grabbing" : drawing ? "crosshair" : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {(notes?.strokes ?? []).map((s, i) => (
          <g key={i} transform={moveSel && picked.has(s) ? `translate(${moveSel.dx} ${moveSel.dy})` : undefined}>
            <StrokePath s={s} />
          </g>
        ))}
        {draft && <StrokePath s={{ c: color, w: tool === "hl" ? HL_WIDTH : PEN_WIDTH, hl: tool === "hl", pts: draft }} />}
        {(notes?.items ?? []).map((raw, i) => (
          <ItemView
            key={i}
            it={drag?.i === i ? applyDrag(raw, drag) : raw}
            scale={scale}
            interactive={itemsInteractive}
            selected={itemsInteractive && active?.i === i}
            editing={itemsInteractive && active?.i === i && !!active?.editing}
            shift={moveSel && picked.has(raw) ? `translate(${moveSel.dx} ${moveSel.dy})` : undefined}
            onDown={(e, mode) => itemDown(e, i, mode)}
            onMove={itemMove}
            onUp={itemUp}
            onCommit={(text, height) => commitText(i, text, height)}
          />
        ))}
        {boxDraft && (
          <rect
            x={Math.min(boxDraft[0], boxDraft[2])}
            y={Math.min(boxDraft[1], boxDraft[3])}
            width={Math.abs(boxDraft[2] - boxDraft[0])}
            height={Math.abs(boxDraft[3] - boxDraft[1])}
            fill="rgb(37 99 235 / 0.05)"
            stroke="#2563eb"
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
          />
        )}
        {lasso && (
          <polygon points={lasso.join(" ")} fill="rgb(37 99 235 / 0.06)" stroke="#2563eb" strokeWidth={1 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} />
        )}
        {area && !selBox && (
          <rect x={area.x} y={area.y} width={area.w} height={area.h} fill="rgb(37 99 235 / 0.04)" stroke="#2563eb" strokeWidth={1.2 / scale} strokeDasharray={`${5 / scale} ${4 / scale}`} />
        )}
        {selBox && (
          <rect
            x={selBox.x - 4 + (moveSel?.dx ?? 0)}
            y={selBox.y - 4 + (moveSel?.dy ?? 0)}
            width={selBox.w + 8}
            height={selBox.h + 8}
            fill="rgb(37 99 235 / 0.04)"
            stroke="#2563eb"
            strokeWidth={1.2 / scale}
            strokeDasharray={`${5 / scale} ${4 / scale}`}
            style={{ cursor: "grab" }}
          />
        )}
      </svg>
      {area && !moveSel && (
        // Actions for the lasso: screenshot the area; for picked notes also recolour / delete.
        <div
          className="absolute z-10 flex flex-wrap items-center gap-1 rounded-2xl border border-border/60 bg-surface px-1.5 py-1 shadow-lg max-w-[19rem]"
          style={{ left: Math.min(area.x, selBox?.x ?? area.x) * scale, top: Math.max(0, (Math.min(area.y, selBox?.y ?? area.y) - 4) * scale - 44) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            title="Copy screenshot of this area"
            aria-label="Copy screenshot"
            onClick={() => copyShot(area)}
            className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-surface-2"
          >
            <Camera className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Save screenshot as PNG"
            aria-label="Save screenshot"
            onClick={() => void saveShot(area)}
            className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-surface-2"
          >
            <ImageDown className="h-4 w-4" />
          </button>
          {selBox && <span className="mx-0.5 h-5 w-px bg-border/60" />}
          {selBox && PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Recolour ${c}`}
              onClick={() => editSelection((st) => (st.hl ? st : { ...st, c }), (it) => (it.t === "text" ? { ...it, c } : it))}
              className="h-5 w-5 rounded-full ring-1 ring-white/30"
              style={{ background: c }}
            />
          ))}
          {selBox && (
            <>
              <CustomColor
                small
                value="#000000"
                onChange={(c) => editSelection((st) => (st.hl ? st : { ...st, c }), (it) => (it.t === "text" ? { ...it, c } : it))}
              />
              <button
                type="button"
                title="Delete (⌫)"
                aria-label="Delete selection"
                onClick={deleteSelection}
                className="h-7 w-7 inline-flex items-center justify-center rounded-full text-critical hover:bg-surface-2"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      )}
      {itemsInteractive && active && !drag && notes?.items?.[active.i] && (() => {
        const it = notes.items[active.i];
        const b = itemBox(it);
        return (
          <div
            className="absolute z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-surface px-1 py-0.5 shadow-lg text-xs"
            style={{ left: b.x * scale, top: Math.max(0, b.y * scale - 40) }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.preventDefault()} // keep typing focus in the box
          >
            {it.t === "text" && (
              <>
                <button type="button" title="Smaller text" onClick={() => setItem(active.i, (x) => (x.t === "text" ? { ...x, size: Math.max(6, x.size - 2) } : x))} className="h-7 w-7 rounded-full hover:bg-surface-2">
                  A−
                </button>
                <span className="w-6 text-center tabular-nums text-muted">{it.size}</span>
                <button type="button" title="Bigger text" onClick={() => setItem(active.i, (x) => (x.t === "text" ? { ...x, size: Math.min(72, x.size + 2) } : x))} className="h-7 w-7 rounded-full hover:bg-surface-2">
                  A+
                </button>
              </>
            )}
            <button
              type="button"
              title="Delete (⌫)"
              aria-label="Delete"
              onClick={() => {
                setItem(active.i, () => null);
                setActive(null);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-full text-critical hover:bg-surface-2"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        );
      })()}
      {onRemove && (
        <button
          type="button"
          title="Remove this blank page"
          aria-label="Remove this blank page"
          onClick={onRemove}
          className="absolute right-2 top-2 z-10 hidden group-hover:inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-gray-700 hover:bg-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** An image or text box on a page; when selected: a frame and corner handles, or a textarea while typing. */
function ItemView({
  it,
  scale,
  interactive,
  selected,
  editing,
  shift,
  onDown,
  onMove,
  onUp,
  onCommit,
}: {
  it: Item;
  scale: number;
  interactive: boolean;
  selected: boolean;
  editing: boolean;
  shift?: string;
  onDown: (e: React.PointerEvent, mode: Drag["mode"]) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
  onCommit: (text: string, contentHeight: number) => void;
}) {
  const b = itemBox(it);
  const body = {
    style: { pointerEvents: interactive ? "all" : "none", cursor: editing ? "text" : "move" } as React.CSSProperties,
    onPointerDown: (e: React.PointerEvent) => onDown(e, "move"),
    onPointerMove: onMove,
    onPointerUp: onUp,
  };
  return (
    <g transform={shift}>
      {it.t === "img" ? (
        <image href={it.src} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio="none" {...body} />
      ) : (
        <foreignObject x={b.x} y={b.y} width={b.w} height={b.h} overflow="visible" {...body}>
          {editing ? (
            <textarea
              autoFocus
              defaultValue={it.text}
              placeholder="Type…"
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation(); // finish typing, don't close the viewer
                e.currentTarget.blur();
              }}
              onInput={(e) => {
                const ta = e.currentTarget;
                ta.style.height = "auto";
                ta.style.height = `${Math.max(b.h, ta.scrollHeight)}px`;
              }}
              onBlur={(e) => onCommit(e.currentTarget.value, e.currentTarget.scrollHeight)}
              className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 shadow-none outline-none ring-0 focus:outline-none focus:ring-0"
              style={{ ...textStyle(it), height: b.h, minHeight: b.h }}
            />
          ) : (
            <div style={textStyle(it)}>{it.text}</div>
          )}
        </foreignObject>
      )}
      {selected && (
        <>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill="none"
            stroke="#2563eb"
            strokeWidth={1.2 / scale}
            strokeDasharray={editing ? `${4 / scale} ${3 / scale}` : undefined}
            pointerEvents="none"
          />
          {!editing &&
            (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
              <rect
                key={c}
                x={(c[1] === "w" ? b.x : b.x + b.w) - 5 / scale}
                y={(c[0] === "n" ? b.y : b.y + b.h) - 5 / scale}
                width={10 / scale}
                height={10 / scale}
                rx={2 / scale}
                fill="#fff"
                stroke="#2563eb"
                strokeWidth={1.2 / scale}
                style={{ pointerEvents: "all", cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(e) => onDown(e, c)}
                onPointerMove={onMove}
                onPointerUp={onUp}
              />
            ))}
        </>
      )}
    </g>
  );
}

/** Any colour, via the system colour picker (a rainbow swatch; shows the colour once picked). */
function CustomColor({
  value,
  active,
  small,
  onChange,
}: {
  value: string;
  active?: boolean;
  small?: boolean;
  onChange: (c: string) => void;
}) {
  return (
    <label
      title="Custom colour"
      className={cn(
        "relative shrink-0 cursor-pointer rounded-full border-2 ring-1 ring-white/30",
        small ? "h-5 w-5" : "h-6 w-6",
        active ? "border-fg" : "border-transparent"
      )}
      style={{ background: active ? value : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Custom colour"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

function StrokePath({ s }: { s: Stroke }) {
  const pts = s.pts.length === 2 ? [...s.pts, ...s.pts] : s.pts; // a tap draws a dot
  return (
    <polyline
      points={pts.join(" ")}
      fill="none"
      stroke={s.c}
      strokeWidth={s.w}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={s.hl ? 0.35 : 1}
      style={s.hl ? { mixBlendMode: "multiply" } : undefined}
    />
  );
}

const mapRound = (b: { x: number; y: number; w: number; h: number }) => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });

function textStyle(it: Extract<Item, { t: "text" }>): React.CSSProperties {
  return {
    fontSize: it.size,
    lineHeight: 1.25,
    color: it.c,
    fontFamily: "Helvetica, Arial, sans-serif",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    padding: 0,
    margin: 0,
  };
}

function itemBox(it: Item) {
  if (it.t === "img") return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.w) return { x: it.x, y: it.y, w: it.w, h: it.h ?? it.size * 1.25 };
  const lines = it.text.split("\n");
  // ponytail: approximate text box (0.55em per char) — good enough for erasing.
  return { x: it.x, y: it.y, w: Math.max(...lines.map((l) => l.length)) * it.size * 0.55, h: lines.length * it.size * 1.2 };
}

function applyDrag(it: Item, d: Drag): Item {
  if (d.mode === "move") return { ...it, x: round(it.x + d.dx), y: round(it.y + d.dy) };
  // Corner resize: the opposite corner stays put. Images keep their aspect ratio.
  const b = itemBox(it);
  const west = d.mode[1] === "w";
  const north = d.mode[0] === "n";
  const w = Math.max(16, west ? b.w - d.dx : b.w + d.dx);
  const h = it.t === "img" ? (w * b.h) / b.w : Math.max(12, north ? b.h - d.dy : b.h + d.dy);
  return {
    ...it,
    x: round(west ? b.x + b.w - w : b.x),
    y: round(north ? b.y + b.h - h : b.y),
    w: round(w),
    h: round(h),
  };
}

/** Shrink pasted/picked images to ≤1600px so notes stay small. */
async function downscale(file: Blob): Promise<{ src: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const png = file.type === "image/png";
  return {
    src: canvas.toDataURL(png ? "image/png" : "image/jpeg", 0.85),
    w: canvas.width * 0.75, // px → pt at 96 dpi
    h: canvas.height * 0.75,
  };
}

type Box = { x: number; y: number; w: number; h: number };

// ── Sync ops (mirrors apply_ops in app/routers/notes.py) ──
type Kind = "strokes" | "items";
type Op =
  | { op: "put"; slot: string; kind: Kind; el: Stroke | Item }
  | { op: "del"; slot: string; kind: Kind; id: string }
  | { op: "layout"; layout: string[] };

const newId = () => Math.random().toString(36).slice(2, 12);

// ── Apple Pencil vs finger ──
// Browsers report pointerType "pen" for an Apple Pencil and "touch" for a finger.
// Once this device has seen a pencil, fingers stop drawing and scroll instead
// (like GoodNotes). Devices that never had one (phones, mouse) are unaffected.
const PENCIL_KEY = "openstudy.pencilSeen";
let pencilSeen = (() => {
  try {
    return localStorage.getItem(PENCIL_KEY) === "1";
  } catch {
    return false;
  }
})();
function notePencil() {
  if (pencilSeen) return;
  pencilSeen = true;
  try {
    localStorage.setItem(PENCIL_KEY, "1");
  } catch {
    /* private mode: remembered for this visit only */
  }
}
const pencilOnly = () => pencilSeen;

/** New strokes/items get an id: their identity for syncing. */
function withIds(n: Notes): Notes {
  let changed = false;
  const fix = <T extends { id?: string }>(xs?: T[]) => {
    if (!xs?.some((x) => !x.id)) return xs;
    changed = true;
    return xs.map((x) => (x.id ? x : { ...x, id: newId() }));
  };
  const pages: Notes["pages"] = {};
  for (const [slot, p] of Object.entries(n.pages)) {
    const strokes = fix(p.strokes);
    const items = fix(p.items);
    pages[slot] = strokes === p.strokes && items === p.items ? p : { ...p, strokes, items };
  }
  return changed ? { ...n, pages } : n;
}

/** The ops that turn `a` into `b`: elements compared by id, changed = a new object. */
function diffNotes(a: Notes, b: Notes, defaultLayout: string[]): Op[] {
  const ops: Op[] = [];
  if (a.layout !== b.layout) ops.push({ op: "layout", layout: b.layout ?? defaultLayout });
  for (const slot of new Set([...Object.keys(a.pages), ...Object.keys(b.pages)])) {
    const pa = a.pages[slot] ?? {};
    const pb = b.pages[slot] ?? {};
    if (pa === pb) continue;
    for (const kind of ["strokes", "items"] as const) {
      const xa: (Stroke | Item)[] = pa[kind] ?? [];
      const xb: (Stroke | Item)[] = pb[kind] ?? [];
      if (xa === xb) continue;
      const before = new Map(xa.map((x) => [x.id, x]));
      const after = new Set(xb.map((x) => x.id));
      for (const x of xb) if (before.get(x.id) !== x) ops.push({ op: "put", slot, kind, el: x });
      for (const x of xa) if (!after.has(x.id)) ops.push({ op: "del", slot, kind, id: x.id! });
    }
  }
  return ops;
}

function applyOps(n: Notes, ops: Op[]): Notes {
  const out: Notes = { ...n, pages: { ...n.pages } };
  for (const op of ops) {
    if (op.op === "layout") {
      out.layout = op.layout;
      continue;
    }
    const page = { ...(out.pages[op.slot] ?? {}) };
    const arr: (Stroke | Item)[] = [...(page[op.kind] ?? [])];
    const id = op.op === "put" ? op.el.id : op.id;
    const at = arr.findIndex((x) => x.id === id);
    if (op.op === "del") {
      if (at >= 0) arr.splice(at, 1);
    } else if (at < 0) arr.push(op.el);
    else arr[at] = op.el;
    if (op.kind === "strokes") page.strokes = arr as Stroke[];
    else page.items = arr as Item[];
    out.pages[op.slot] = page;
  }
  return out;
}

/** Keep the old object for every unchanged element, so selections (held by identity) survive a sync. */
function reuseUnchanged(next: Notes, prev: Notes | null): Notes {
  if (!prev) return next;
  const keep = <T extends { id?: string }>(xs?: T[], old?: T[]) => {
    if (!xs || !old) return xs;
    const byId = new Map(old.map((o) => [o.id, o]));
    return xs.map((x) => {
      const o = byId.get(x.id);
      return o && JSON.stringify(o) === JSON.stringify(x) ? o : x;
    });
  };
  const pages: Notes["pages"] = {};
  for (const [slot, p] of Object.entries(next.pages)) {
    const q = prev.pages[slot];
    pages[slot] = { ...p, strokes: keep(p.strokes, q?.strokes), items: keep(p.items, q?.items) };
  }
  return { ...next, pages };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Draw a page's notes on a 2D canvas (already transformed to page points) — the screenshot's overlay. */
async function drawNotes(g: CanvasRenderingContext2D, notes?: PageNotes) {
  for (const s of notes?.strokes ?? []) {
    const pts = s.pts.length === 2 ? [...s.pts, ...s.pts] : s.pts;
    g.save();
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length - 1; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.strokeStyle = s.c;
    g.lineWidth = s.w;
    g.lineCap = "round";
    g.lineJoin = "round";
    if (s.hl) {
      g.globalAlpha = 0.35;
      g.globalCompositeOperation = "multiply";
    }
    g.stroke();
    g.restore();
  }
  for (const it of notes?.items ?? []) {
    if (it.t === "img") {
      const img = new Image();
      img.src = it.src;
      await img.decode().catch(() => {});
      g.drawImage(img, it.x, it.y, it.w, it.h);
      continue;
    }
    g.fillStyle = it.c;
    g.font = `${it.size}px Helvetica, Arial, sans-serif`;
    g.textBaseline = "top";
    const lh = it.size * 1.25;
    const lines = it.w ? wrapLines(g, it.text, it.w) : it.text.split("\n");
    lines.forEach((line, i) => g.fillText(line, it.x, it.y + i * lh + (lh - it.size) / 2));
  }
}

/** Word-wrap like the on-page text box (pre-wrap, break long words). */
function wrapLines(g: CanvasRenderingContext2D, text: string, width: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (g.measureText(next).width <= width || !line) {
        line = next;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line);
  }
  return out;
}

function pointInPolygon(x: number, y: number, poly: number[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length - 1; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boundsOf(strokes: Stroke[], items: Item[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const st of strokes) {
    for (let i = 0; i < st.pts.length - 1; i += 2) {
      x0 = Math.min(x0, st.pts[i] - st.w / 2);
      x1 = Math.max(x1, st.pts[i] + st.w / 2);
      y0 = Math.min(y0, st.pts[i + 1] - st.w / 2);
      y1 = Math.max(y1, st.pts[i + 1] + st.w / 2);
    }
  }
  for (const it of items) {
    const b = itemBox(it);
    [x0, y0, x1, y1] = [Math.min(x0, b.x), Math.min(y0, b.y), Math.max(x1, b.x + b.w), Math.max(y1, b.y + b.h)];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
