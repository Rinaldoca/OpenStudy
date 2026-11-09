import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Download,
  Eraser,
  FilePlus2,
  Highlighter,
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
type Stroke = { c: string; w: number; hl?: boolean; pts: number[] };
type Item =
  | { t: "img"; src: string; x: number; y: number; w: number; h: number }
  | { t: "text"; text: string; x: number; y: number; size: number; c: string };
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

  const [notes, setNotes] = useState<Notes | null>(null);
  const notesRef = useRef<Notes | null>(null);
  const history = useRef<Notes[]>([]);
  const dirty = useRef(false);
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

  // ── Load + autosave notes ──
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ data: Notes | null }>("/api/notes", { path })
      .then((r) => !cancelled && setNotes(r.data ?? { pages: {} }))
      .catch(() => !cancelled && setNotes({ pages: {} }));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(async () => {
    if (!dirty.current || !notesRef.current) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      await apiFetch("/api/notes", { method: "PUT", body: { path, data: notesRef.current } });
      setSaveState(dirty.current ? "saving" : "saved");
    } catch {
      dirty.current = true;
      setSaveState("error");
    }
  }, [path]);

  useEffect(() => {
    notesRef.current = notes;
    if (!dirty.current) return;
    const t = setTimeout(save, 1200);
    return () => clearTimeout(t);
  }, [notes, save]);
  useEffect(() => () => void save(), [save]); // flush when the viewer closes

  const update = useCallback((fn: (n: Notes) => Notes) => {
    setNotes((prev) => {
      if (!prev) return prev;
      history.current.push(prev);
      if (history.current.length > 100) history.current.shift();
      dirty.current = true;
      return fn(prev);
    });
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) {
      dirty.current = true;
      setNotes(prev);
    }
  }, []);

  const numPages = doc?.numPages ?? 0;
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

  const insertImage = useCallback(
    async (file: Blob) => {
      const img = await downscale(file);
      const w = Math.min(size.w * 0.6, img.w);
      const h = (w * img.h) / img.w;
      updatePage(currentSlot.current, (p) => ({
        ...p,
        items: [...(p.items ?? []), { t: "img", src: img.src, x: round((size.w - w) / 2), y: round(size.h * 0.15), w: round(w), h: round(h) }],
      }));
      setTool("select");
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
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [insertImage, undo, zoomTo]);

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
    await save();
    window.location.href = `${API_BASE}/api/notes/export?path=${encodeURIComponent(path)}`;
  }

  const color = tool === "hl" ? hlColor : penColor;
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
          {(tool === "pen" || tool === "hl" || tool === "text") && (
            <div className="flex flex-wrap justify-center gap-1.5 rounded-2xl border border-border/60 bg-surface px-2 py-1.5 shadow-lg">
              {(tool === "hl" ? HL_COLORS : PEN_COLORS).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => (tool === "hl" ? setHlColor(c) : setPenColor(c))}
                  className={cn("h-6 w-6 rounded-full border-2 ring-1 ring-white/30", color === c ? "border-fg" : "border-transparent")}
                  style={{ background: c }}
                />
              ))}
              <CustomColor
                value={color}
                active={!(tool === "hl" ? HL_COLORS : PEN_COLORS).includes(color)}
                onChange={(c) => (tool === "hl" ? setHlColor(c) : setPenColor(c))}
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
              title={saveState === "error" ? "Couldn't save — retrying on next change" : saveState === "saving" ? "Saving…" : "Saved"}
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

type Drag = { i: number; mode: "move" | "resize"; x0: number; y0: number; dx: number; dy: number };

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
  const erasing = useRef(false);
  // Lasso: the loop being drawn, the selected strokes/items (by identity, so an
  // undo that swaps them out simply empties the selection), and a pending move.
  const [lasso, setLasso] = useState<number[] | null>(null);
  const [picked, setPicked] = useState<Set<Stroke | Item>>(new Set());
  const [moveSel, setMoveSel] = useState<{ x0: number; y0: number; dx: number; dy: number } | null>(null);
  const selStrokes = tool === "lasso" ? (notes?.strokes ?? []).filter((x) => picked.has(x)) : [];
  const selItems = tool === "lasso" ? (notes?.items ?? []).filter((x) => picked.has(x)) : [];
  const hasSel = selStrokes.length + selItems.length > 0;
  const selBox = hasSel ? boundsOf(selStrokes, selItems) : null;

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
    const pt = toPt(e);
    if (tool === "lasso") {
      svgRef.current!.setPointerCapture(e.pointerId);
      const b = selBox;
      if (b && pt[0] >= b.x - 6 && pt[0] <= b.x + b.w + 6 && pt[1] >= b.y - 6 && pt[1] <= b.y + b.h + 6) {
        setMoveSel({ x0: pt[0], y0: pt[1], dx: 0, dy: 0 }); // drag the selection
      } else {
        setPicked(new Set());
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
      const text = window.prompt("Text");
      if (text?.trim()) {
        onChange((p) => ({ ...p, items: [...(p.items ?? []), { t: "text", text, x: pt[0], y: pt[1], size: 14, c: color }] }));
      }
    }
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (lasso) {
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
  function onPointerUp() {
    erasing.current = false;
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
      return;
    }
    if (moveSel) {
      const { dx, dy } = moveSel;
      setMoveSel(null);
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

  // Backspace/Delete removes the selection, Escape clears it.
  useEffect(() => {
    if (!hasSel) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelectionRef.current();
      } else if (e.key === "Escape") {
        e.stopPropagation(); // don't close the viewer
        setPicked(new Set());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hasSel]);
  const deleteSelectionRef = useRef(deleteSelection);
  useEffect(() => {
    deleteSelectionRef.current = deleteSelection;
  });

  // Move/resize images and text boxes (select + text tools).
  function itemDown(e: React.PointerEvent, i: number, mode: Drag["mode"]) {
    e.stopPropagation();
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
  function editText(i: number) {
    const it = notes?.items?.[i];
    if (it?.t !== "text") return;
    const text = window.prompt("Text", it.text);
    if (text === null) return;
    onChange((p) => ({
      ...p,
      items: (p.items ?? []).flatMap((x, j) => (j !== i ? [x] : text.trim() ? [{ ...it, text }] : [])),
    }));
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
        {(notes?.items ?? []).map((raw, i) => {
          const it = drag?.i === i ? applyDrag(raw, drag) : raw;
          const handlers = {
            style: { pointerEvents: itemsInteractive ? "all" : "none", cursor: "move" } as React.CSSProperties,
            onPointerDown: (e: React.PointerEvent) => itemDown(e, i, "move"),
            onPointerMove: itemMove,
            onPointerUp: itemUp,
          };
          const shift = moveSel && picked.has(raw) ? `translate(${moveSel.dx} ${moveSel.dy})` : undefined;
          if (it.t === "img") {
            return (
              <g key={i} transform={shift}>
                <image href={it.src} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio="none" {...handlers} />
                {itemsInteractive && (
                  <rect
                    x={it.x + it.w - 6}
                    y={it.y + it.h - 6}
                    width={12}
                    height={12}
                    rx={2}
                    className="fill-white stroke-gray-500"
                    style={{ pointerEvents: "all", cursor: "nwse-resize" }}
                    onPointerDown={(e) => itemDown(e, i, "resize")}
                    onPointerMove={itemMove}
                    onPointerUp={itemUp}
                  />
                )}
              </g>
            );
          }
          return (
            <text key={i} transform={shift} fontSize={it.size} fill={it.c} fontFamily="Helvetica, Arial, sans-serif" onDoubleClick={() => editText(i)} {...handlers}>
              {it.text.split("\n").map((line, j) => (
                <tspan key={j} x={it.x} y={it.y + it.size * (j + 1)}>
                  {line}
                </tspan>
              ))}
            </text>
          );
        })}
        {lasso && (
          <polygon points={lasso.join(" ")} fill="rgb(37 99 235 / 0.06)" stroke="#2563eb" strokeWidth={1 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} />
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
      {selBox && !moveSel && (
        // Actions for the lasso selection: recolour ink/text, delete.
        <div
          className="absolute z-10 flex flex-wrap items-center gap-1 rounded-2xl border border-border/60 bg-surface px-1.5 py-1 shadow-lg max-w-[19rem]"
          style={{ left: selBox.x * scale, top: Math.max(0, (selBox.y - 4) * scale - 44) }}
        >
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Recolour ${c}`}
              onClick={() => editSelection((st) => (st.hl ? st : { ...st, c }), (it) => (it.t === "text" ? { ...it, c } : it))}
              className="h-5 w-5 rounded-full ring-1 ring-white/30"
              style={{ background: c }}
            />
          ))}
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
        </div>
      )}
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

function itemBox(it: Item) {
  if (it.t === "img") return { x: it.x, y: it.y, w: it.w, h: it.h };
  const lines = it.text.split("\n");
  // ponytail: approximate text box (0.55em per char) — good enough for erasing.
  return { x: it.x, y: it.y, w: Math.max(...lines.map((l) => l.length)) * it.size * 0.55, h: lines.length * it.size * 1.2 };
}

function applyDrag(it: Item, d: Drag): Item {
  if (d.mode === "move") return { ...it, x: round(it.x + d.dx), y: round(it.y + d.dy) };
  if (it.t !== "img") return it;
  const w = Math.max(16, it.w + d.dx);
  return { ...it, w: round(w), h: round((w * it.h) / it.w) }; // keep aspect ratio
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
