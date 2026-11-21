/* Which files are open in the viewer lives in the URL:
 *   ?file=A&file=B&active=B&split=A
 * so the browser's Back button, reloads and copied links all keep it, and any
 * page can open a file. The single viewer is mounted in the app shell
 * (components/files/file-viewer.tsx → OpenFilesViewer). Opening pushes a
 * history entry; switching or closing tabs replaces it, so Back goes to the
 * previous file or folder, not through every tab click. */
import { useCallback } from "react";
import { useSearchParams } from "react-router";

export const MAX_TABS = 8;

export function useOpenFiles() {
  const [params, setParams] = useSearchParams();
  const tabs = params.getAll("file");
  const activeParam = params.get("active");
  const active = activeParam && tabs.includes(activeParam) ? activeParam : (tabs[tabs.length - 1] ?? null);
  const split = params.get("split");
  // Home: the viewer is tucked away (tabs stay open) until shown again.
  const hidden = params.get("viewer") === "hidden";

  const update = useCallback(
    (fn: (p: URLSearchParams) => void, replace: boolean) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          fn(next);
          return next;
        },
        { replace }
      ),
    [setParams]
  );

  const open = useCallback(
    (path: string) =>
      update((p) => {
        let files = p.getAll("file");
        if (!files.includes(path)) {
          files = [...files, path];
          // Too many: drop the oldest that isn't on screen.
          while (files.length > MAX_TABS) {
            const drop = files.find((f) => f !== p.get("active") && f !== p.get("split")) ?? files[0];
            files = files.filter((f) => f !== drop);
          }
        }
        p.delete("file");
        files.forEach((f) => p.append("file", f));
        p.set("active", path);
        p.delete("viewer");
      }, false),
    [update]
  );

  const activate = useCallback(
    (path: string) =>
      update((p) => {
        p.set("active", path);
        if (p.get("split") === path) p.delete("split");
      }, true),
    [update]
  );

  const closeTab = useCallback(
    (path: string) =>
      update((p) => {
        const files = p.getAll("file").filter((f) => f !== path);
        p.delete("file");
        files.forEach((f) => p.append("file", f));
        if (p.get("split") === path) p.delete("split");
        if (p.get("active") === path) {
          const next = files.filter((f) => f !== p.get("split")).slice(-1)[0];
          if (next) p.set("active", next);
          else p.delete("active");
        }
        if (files.length === 0) {
          p.delete("active");
          p.delete("split");
          p.delete("viewer");
        }
      }, true),
    [update]
  );

  const setSplit = useCallback(
    (path: string | null) =>
      update((p) => {
        if (path) p.set("split", path);
        else p.delete("split");
      }, true),
    [update]
  );

  const closeAll = useCallback(
    () =>
      update((p) => {
        p.delete("file");
        p.delete("active");
        p.delete("split");
        p.delete("viewer");
      }, false),
    [update]
  );

  // Pushes, so Back from the folders brings the viewer straight back.
  const hide = useCallback(() => update((p) => p.set("viewer", "hidden"), false), [update]);
  const show = useCallback(() => update((p) => p.delete("viewer"), true), [update]);

  return { tabs, active, split, hidden, open, activate, closeTab, setSplit, closeAll, hide, show };
}
