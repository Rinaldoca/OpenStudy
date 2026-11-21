import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Columns2, ExternalLink, File as FileIcon, Folder, Home, Layers, Loader2, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setOpenFile } from "@/lib/ai";
import { api } from "@/lib/api";
import { PdfView } from "./pdf-view";
import { useFileSignedUrl } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { MAX_TABS, useOpenFiles } from "@/lib/open-files";
export const fileName = (path: string) => path.split("/").pop() || path;

/** The one file viewer, mounted in the app shell; opened via useOpenFiles().open(path). */
export function OpenFilesViewer() {
  const { t } = useTranslation();
  const { tabs, active, split, hidden, open, activate, closeTab, setSplit, closeAll, hide, show } = useOpenFiles();
  if (!active) return null;
  return (
    <>
      {hidden && (
        <button
          type="button"
          onClick={show}
          className="fixed z-[45] left-4 bottom-24 md:bottom-6 inline-flex items-center gap-2 rounded-full bg-fg text-bg px-4 py-2.5 text-sm font-medium shadow-lg hover:scale-105 transition-transform"
        >
          <Layers className="h-4 w-4" />
          {t("files.openFiles", { count: tabs.length })}
        </button>
      )}
      <FileViewer
      hidden={hidden}
      onHome={hide}
      tabs={tabs}
      active={active}
      split={split}
      // The + picker lists files of the course the active file is in.
      root={active.includes("/") ? active.split("/")[0] : ""}
      onActivate={activate}
      onOpen={open}
      onCloseTab={closeTab}
      onSplit={setSplit}
      onClose={closeAll}
      />
    </>
  );
}

/** Full-screen viewer with tabs: several files open at once, switch between
 *  them, and on wide screens show two side by side (e.g. slides + exercise
 *  sheet). Which files are open lives in the URL (see FileBrowser), so the
 *  browser's Back button and reloads keep it. Tabs stay mounted while open,
 *  so each keeps its scroll position and zoom. */
export function FileViewer({
  hidden = false,
  onHome,
  tabs,
  active,
  split,
  root,
  onActivate,
  onOpen,
  onCloseTab,
  onSplit,
  onClose,
}: {
  /** Tucked away by Home: stays mounted (tabs keep scroll and zoom) but invisible. */
  hidden?: boolean;
  onHome?: () => void;
  tabs: string[];
  active: string;
  /** Second file shown next to `active`, or null. */
  split: string | null;
  /** Folder the + picker lists files from ("" = everything). */
  root: string;
  onActivate: (path: string) => void;
  onOpen: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSplit: (path: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [picker, setPicker] = useState(false);
  // In split view: which side you're working in (gets paste, shortcuts, Ask AI).
  const [focus, setFocus] = useState<"main" | "split">("main");
  const showSplit = split && split !== active && tabs.includes(split) ? split : null;
  const focusedPath = showSplit && focus === "split" ? showSplit : active;

  useEffect(() => {
    setOpenFile(hidden ? null : focusedPath);
    return () => setOpenFile(null);
  }, [focusedPath, hidden]);
  useEffect(() => {
    if (!showSplit) setFocus("main");
  }, [showSplit]);

  // Escape closes the picker first, then the viewer. (PdfView stops Escape
  // while it uses it for its own selection.)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hidden) return;
      if (picker) setPicker(false);
      else onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, picker, hidden]);

  const other = tabs.filter((p) => p !== active).slice(-1)[0];

  return (
    <div
      className={cn(
        // right: leaves room for the Ask AI panel when it's open (--ai-panel-w, set by AskAi).
        "fixed inset-0 right-[var(--ai-panel-w,0px)] z-50 flex flex-col bg-black/80 animate-in fade-in-0 duration-150",
        hidden && "invisible pointer-events-none"
      )}
      aria-hidden={hidden}
      onClick={onClose}
    >
      <div
        className="flex items-center gap-1 px-2 pt-2 border-b border-border/60 bg-surface safe-top"
        onClick={(e) => e.stopPropagation()}
      >
        {onHome && (
          <button
            type="button"
            onClick={onHome}
            aria-label={t("files.home")}
            title={t("files.home")}
            className="shrink-0 mb-1 touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
          >
            <Home className="h-4 w-4" />
          </button>
        )}
        <div className="flex-1 min-w-0 flex items-end gap-1 overflow-x-auto no-scrollbar">
          {tabs.map((p) => {
            const isActive = p === active;
            const isSplit = p === showSplit;
            return (
              <div
                key={p}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={p}
                onClick={() => (isSplit ? setFocus("split") : (onActivate(p), setFocus("main")))}
                onKeyDown={(e) => e.key === "Enter" && onActivate(p)}
                onAuxClick={(e) => e.button === 1 && onCloseTab(p)}
                className={cn(
                  "group flex items-center gap-1.5 max-w-[14rem] shrink-0 rounded-t-md border border-b-0 px-3 py-2 text-sm cursor-pointer select-none",
                  isActive || isSplit
                    ? "bg-bg border-border/60 text-fg"
                    : "bg-surface-2/60 border-transparent text-muted hover:text-fg"
                )}
              >
                <FileIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{fileName(p)}</span>
                {isSplit && <Columns2 className="h-3 w-3 shrink-0 text-muted" />}
                <button
                  type="button"
                  aria-label={t("files.closeTab", { name: fileName(p) })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(p);
                  }}
                  className="ml-0.5 rounded p-0.5 text-muted hover:text-fg hover:bg-surface-3"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setPicker(true)}
            disabled={tabs.length >= MAX_TABS}
            aria-label={t("files.openAnother")}
            title={t("files.openAnother")}
            className="shrink-0 mb-1 touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {tabs.length >= 2 && (
          <button
            type="button"
            onClick={() => onSplit(showSplit ? null : (other ?? null))}
            aria-pressed={!!showSplit}
            aria-label={t("files.sideBySide")}
            title={t("files.sideBySide")}
            className={cn(
              "hidden md:inline-flex mb-1 touch-target items-center justify-center rounded-md hover:bg-surface-2",
              showSplit ? "text-fg bg-surface-2" : "text-muted hover:text-fg"
            )}
          >
            <Columns2 className="h-4 w-4" />
          </button>
        )}
        <SignedLink path={focusedPath} />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("files.closeViewer")}
          className="mb-1 touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 bg-bg flex" onClick={(e) => e.stopPropagation()}>
        {/* Left / only pane: every tab that isn't on the right stays mounted here,
            hidden unless active, so switching keeps scroll and zoom. */}
        <div
          className={cn("relative min-w-0 flex-1", showSplit && "border-r border-border/60")}
          onPointerDownCapture={() => setFocus("main")}
        >
          {tabs
            .filter((p) => p !== showSplit)
            .map((p) => (
              <Pane key={p} path={p} visible={p === active} focused={focusedPath === p} />
            ))}
        </div>
        {showSplit && (
          <div className="relative min-w-0 flex-1" onPointerDownCapture={() => setFocus("split")}>
            <Pane key={showSplit} path={showSplit} visible focused={focusedPath === showSplit} />
          </div>
        )}
      </div>

      {picker && (
        <FilePicker
          root={root}
          open={tabs}
          onPick={(p) => {
            setPicker(false);
            onOpen(p);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

function SignedLink({ path }: { path: string }) {
  const { t } = useTranslation();
  const { data } = useFileSignedUrl(path);
  if (!data?.url) return null;
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noreferrer"
      aria-label={t("files.openInBrowserTab")}
      title={t("files.openInBrowserTab")}
      className="mb-1 touch-target inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-2"
    >
      <ExternalLink className="h-4 w-4" />
    </a>
  );
}

function Pane({ path, visible, focused }: { path: string; visible: boolean; focused: boolean }) {
  const { data, isPending, error } = useFileSignedUrl(path);
  const name = fileName(path);
  const ext = name.toLowerCase().split(".").pop() || "";
  return (
    // `invisible` (not display:none) keeps the size, so a hidden PDF keeps its layout.
    <div className={cn("absolute inset-0 overflow-hidden", !visible && "invisible pointer-events-none")} aria-hidden={!visible}>
      {isPending && (
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
        </div>
      )}
      {error && (
        <div className="h-full flex items-center justify-center p-6">
          <p className="text-sm text-critical">Couldn't load file.</p>
        </div>
      )}
      {data?.url && !isPending && !error && (
        <FileContent url={data.url} ext={ext} name={name} path={path} focused={focused && visible} />
      )}
    </div>
  );
}

/** + in the tab bar: browse folders (starting in the active file's course) or
 *  search every file below the folder you're in, and open one in a new tab. */
function FilePicker({
  root,
  open,
  onPick,
  onClose,
}: {
  root: string;
  open: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [dir, setDir] = useState(root);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // One listing of everything; folders are derived from the file paths.
  const manifest = useQuery({
    queryKey: ["files", "manifest", ""],
    queryFn: () => api.get<{ files: { path: string }[] }>("/api/files/manifest", { prefix: "" }),
    staleTime: 30_000,
  });
  useEffect(() => inputRef.current?.focus(), []);

  const all = useMemo(() => (manifest.data?.files ?? []).map((f) => f.path), [manifest.data]);
  const under = dir ? `${dir}/` : "";
  const { folders, files } = useMemo(() => {
    const folderSet = new Set<string>();
    const fileList: string[] = [];
    for (const p of all) {
      if (!p.startsWith(under)) continue;
      const rest = p.slice(under.length);
      const slash = rest.indexOf("/");
      if (slash === -1) fileList.push(p);
      else folderSet.add(rest.slice(0, slash));
    }
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    return {
      folders: [...folderSet].sort(byName),
      files: fileList.sort((a, b) => byName(fileName(a), fileName(b))),
    };
  }, [all, under]);
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    return all.filter((p) => p.startsWith(under) && words.every((w) => p.toLowerCase().includes(w))).slice(0, 200);
  }, [all, q, under]);
  const crumbs = dir ? dir.split("/") : [];

  const fileRow = (p: string, showPath: boolean) => {
    const isOpen = open.includes(p);
    return (
      <button
        key={p}
        type="button"
        disabled={isOpen}
        onClick={() => onPick(p)}
        className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <FileIcon className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm truncate">{fileName(p)}</span>
          {showPath && <span className="block text-[11px] text-muted truncate">{p}</span>}
        </span>
        {isOpen && <span className="text-[11px] text-muted shrink-0">{t("files.alreadyOpen")}</span>}
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-border/60 bg-surface shadow-2xl flex flex-col max-h-[75vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative border-b border-border/60">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const first = matches?.find((p) => !open.includes(p));
              if (e.key === "Enter" && first) onPick(first);
            }}
            placeholder={t("files.findFile")}
            className="w-full bg-transparent pl-9 pr-3 py-3 text-sm focus:outline-none"
          />
        </div>
        <nav className="flex items-center gap-1 flex-wrap px-4 py-2 text-xs text-muted border-b border-border/60">
          <button type="button" onClick={() => setDir("")} className="hover:text-fg">
            {t("files.title")}
          </button>
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))} className="hover:text-fg">
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {manifest.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted m-4" />}
          {matches ? (
            matches.length === 0 ? (
              <p className="p-4 text-sm text-muted">{t("files.noMatches")}</p>
            ) : (
              matches.map((p) => fileRow(p, true))
            )
          ) : (
            <>
              {folders.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDir(under + f)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-surface-2"
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted" />
                  <span className="text-sm truncate flex-1">{f}</span>
                  <ChevronRight className="h-4 w-4 text-muted" />
                </button>
              ))}
              {files.map((p) => fileRow(p, false))}
              {manifest.data && !folders.length && !files.length && (
                <p className="p-4 text-sm text-muted">{t("files.emptyFolder")}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileContent({
  url,
  ext,
  name,
  path,
  focused,
}: {
  url: string;
  ext: string;
  name: string;
  path: string;
  focused: boolean;
}) {
  if (ext === "pdf") {
    // Rendered in-page (not an iframe): selectable text for Ask AI, pen
    // tools for notes, and scrolling that works on iOS too.
    return <PdfView url={url} path={path} focused={focused} />;
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    return (
      <div className="h-full flex items-center justify-center p-4 overflow-auto">
        <img src={url} alt={name} className={cn("max-w-full max-h-full object-contain")} />
      </div>
    );
  }
  if (["md", "txt", "typ", "csv", "json"].includes(ext)) {
    return <TextContent url={url} />;
  }
  // Unknown type — offer a download link
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted">No inline viewer for `.{ext}` files.</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-fg text-sm font-medium px-4 py-2 hover:bg-primary/90 transition-colors"
      >
        <ExternalLink className="h-4 w-4" /> Open in new tab
      </a>
    </div>
  );
}

function TextContent({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => alive && setText(t))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <p className="p-6 text-sm text-critical">Fetch failed: {err}</p>;
  if (text === null)
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  return (
    <pre className="h-full w-full overflow-auto p-4 md:p-6 text-[13px] leading-relaxed whitespace-pre-wrap font-mono text-fg">
      {text}
    </pre>
  );
}
