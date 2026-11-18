/* Collect files for upload with their paths relative to what was picked or
 * dropped, so a whole folder from the user's computer lands on the server
 * with the same structure. Used by components/files/file-browser.tsx. */

export type PickedFile = { file: File; rel: string };

// OS clutter and VCS folders that nobody wants mirrored onto the server.
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]);
const JUNK_DIRS = new Set([".git", ".svn", "__MACOSX", "node_modules", ".Trash"]);

export function isJunk(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  return (
    JUNK_NAMES.has(name) ||
    name.startsWith("._") ||
    parts.slice(0, -1).some((d) => JUNK_DIRS.has(d))
  );
}

/** Files from an <input type="file"> — with `webkitdirectory` each one
 *  carries its path inside the chosen folder (e.g. "Lectures/week1/a.pdf"). */
export function fromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? [])
    .map((file) => ({ file, rel: file.webkitRelativePath || file.name }))
    .filter((p) => !isJunk(p.rel));
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; keep reading until empty.
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, base: string, out: PickedFile[]): Promise<void> {
  const rel = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    if (!isJunk(rel)) out.push({ file, rel });
  } else if (entry.isDirectory && !JUNK_DIRS.has(entry.name)) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, rel, out);
  }
}

/** Files and folders dragged onto the page (folders walked recursively). */
export async function fromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  // Grab every entry synchronously: the DataTransfer is emptied after the first await.
  const entries = Array.from(dt.items)
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, rel: file.name }));
  }
  const out: PickedFile[] = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}

/** Run `task` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await task(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
