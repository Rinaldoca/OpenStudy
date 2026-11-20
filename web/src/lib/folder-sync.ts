/* "Sync from computer": keep a server folder up to date with a folder on the
 * user's own computer, uploading only what's new or changed.
 *
 * Chromium browsers (Chrome, Edge, Brave, Arc) can remember the folder via the
 * File System Access API: the handle is kept in IndexedDB, so later syncs are
 * one click (plus a permission prompt the browser may show again). Safari and
 * Firefox can't, so they pick the folder each time (<input webkitdirectory>).
 * Files deleted on the computer are NOT deleted on the server.
 * Used by components/files/file-browser.tsx; server side: GET /api/files/manifest. */
import { isJunk, type PickedFile } from "./upload-tree";

export type RemoteFile = { path: string; size: number; mtime_ms: number };

// Same folding as the server's _sanitize_path (app/routers/files.py), so a local
// "Übung.pdf" matches the stored "Uebung.pdf" instead of uploading every time.
const UMLAUTS: Record<string, string> = {
  ä: "ae", ö: "oe", ü: "ue", ß: "ss", Ä: "Ae", Ö: "Oe", Ü: "Ue",
};
export function sanitizePath(p: string): string {
  const folded = p
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUTS[c])
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "");
  return folded.split("/").filter(Boolean).join("/");
}

const isHidden = (rel: string) => rel.split("/").some((seg) => seg.startsWith("."));

/** Files that need uploading: missing on the server, a different size, or
 *  modified on the computer after the server copy was written. */
export function planSync(local: PickedFile[], remote: RemoteFile[]): PickedFile[] {
  const byPath = new Map(remote.map((r) => [r.path, r]));
  return local.filter(({ file, rel }) => {
    if (isJunk(rel) || isHidden(rel)) return false;
    const r = byPath.get(sanitizePath(rel));
    if (!r) return true;
    // 2 s of slack: some file systems store whole seconds.
    return r.size !== file.size || file.lastModified > r.mtime_ms + 2000;
  });
}

/** Paths from <input webkitdirectory> start with the chosen folder's own name;
 *  drop it so the folder's *contents* map onto the server folder. */
export function stripRoot(picked: PickedFile[]): PickedFile[] {
  return picked
    .map((p) => ({ ...p, rel: p.rel.split("/").slice(1).join("/") }))
    .filter((p) => p.rel);
}

// ── Remembered folders (Chromium only) ─────────────────────────────────────

type Perm = "granted" | "denied" | "prompt";
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: "read" }): Promise<Perm>;
  requestPermission(o: { mode: "read" }): Promise<Perm>;
  values(): AsyncIterable<FileSystemHandle>;
};

export const canRemember =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

const DB = "openstudy-folder-sync";
const STORE = "handles";

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

const key = (userId: string, prefix: string) => `${userId}:${prefix}`;

export async function rememberedFolder(userId: string, prefix: string): Promise<DirHandle | null> {
  if (!canRemember) return null;
  try {
    return ((await withStore("readonly", (s) => s.get(key(userId, prefix)))) as DirHandle) ?? null;
  } catch {
    return null; // private window, storage blocked, …
  }
}

/** Opens the folder picker and remembers the choice for this server folder. */
export async function chooseFolder(userId: string, prefix: string): Promise<DirHandle> {
  const pick = (window as unknown as { showDirectoryPicker(o?: object): Promise<DirHandle> })
    .showDirectoryPicker;
  const handle = await pick({ id: "openstudy-sync", mode: "read" });
  try {
    await withStore("readwrite", (s) => s.put(handle, key(userId, prefix)));
  } catch {
    /* works for this sync, just won't be remembered */
  }
  return handle;
}

/** Must run inside a click handler: may show the browser's permission prompt. */
export async function canRead(handle: DirHandle): Promise<boolean> {
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

export async function readFolder(handle: DirHandle, base = ""): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for await (const entry of handle.values()) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (isJunk(rel) || entry.name.startsWith(".")) continue;
    if (entry.kind === "file") {
      out.push({ file: await (entry as FileSystemFileHandle).getFile(), rel });
    } else {
      out.push(...(await readFolder(entry as DirHandle, rel)));
    }
  }
  return out;
}
