import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { DirEntry, EditorProfile, FileRead } from "@thingmaker/contracts";
import { api, toDesktopError } from "../ipc";
import { useStore } from "../store";

const CodeEditor = lazy(() => import("./MonacoEditor"));

type TreeNode = { entry: DirEntry; children: DirEntry[] | null; open: boolean };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const EDITORS: { id: EditorProfile; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "rider", label: "Rider" },
  { id: "system", label: "System editor" },
];

/**
 * Lazy, ignore-aware explorer plus a Monaco editor with hash-checked saves
 * (FS-02, FS-03, EDT-01/02). Hidden-by-ignore files are a display filter only.
 */
export function FilesPane({ workspaceId }: { workspaceId: string }) {
  const setError = (error: unknown) => useStore.setState({ error: toDesktopError(error) });
  const [showIgnored, setShowIgnored] = useState(false);
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [selected, setSelected] = useState<FileRead | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    try {
      setRootEntries(await api.workspaceListDir(workspaceId, "", showIgnored));
      setNodes({});
    } catch (error) {
      setError(error);
    }
  }, [workspaceId, showIgnored]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  const toggleDir = async (entry: DirEntry) => {
    const node = nodes[entry.relativePath];
    if (node?.children) {
      setNodes({ ...nodes, [entry.relativePath]: { ...node, open: !node.open } });
      return;
    }
    try {
      const children = await api.workspaceListDir(workspaceId, entry.relativePath, showIgnored);
      setNodes({ ...nodes, [entry.relativePath]: { entry, children, open: true } });
    } catch (error) {
      setError(error);
    }
  };

  const openFile = async (relativePath: string) => {
    try {
      const read = await api.fileRead(workspaceId, relativePath, 0, 20000);
      setSelected(read);
      setDraft(read.content);
      setDirty(false);
      setNotice(read.truncated ? `Showing the first ${read.returnedLines} of ${read.totalLines} lines; editing is disabled for partial reads.` : null);
    } catch (error) {
      setError(error);
    }
  };

  const save = async () => {
    if (!selected || !dirty) return;
    setSaving(true);
    try {
      const outcome = await api.fileWriteChecked(workspaceId, selected.relativePath, selected.contentHash, draft);
      const reread = await api.fileRead(workspaceId, selected.relativePath, 0, 20000);
      setSelected(reread);
      setDraft(reread.content);
      setDirty(false);
      setNotice(`Saved ${outcome.relativePath} (${formatBytes(outcome.bytes)}).`);
    } catch (error) {
      const desktopError = toDesktopError(error);
      if (desktopError.code === "CONFLICT") {
        setNotice("The file changed on disk since you opened it (agent or another editor). Your edit was not written. Reload to see the current content; your text stays in the editor.");
      } else {
        setError(desktopError);
      }
    } finally {
      setSaving(false);
    }
  };

  const openExternal = async (editor: EditorProfile) => {
    if (!selected) return;
    try {
      await api.openInEditor(workspaceId, selected.relativePath, editor);
    } catch (error) {
      setError(error);
    }
  };

  const renderEntries = (entries: DirEntry[], depth: number) =>
    entries.map((entry) => {
      const node = nodes[entry.relativePath];
      const isDir = entry.kind === "dir";
      return (
        <li key={entry.relativePath}>
          <button
            className={`tree-item ${entry.ignored ? "muted" : ""} ${selected?.relativePath === entry.relativePath ? "selected" : ""}`}
            onClick={() => (isDir ? void toggleDir(entry) : entry.kind === "file" ? void openFile(entry.relativePath) : undefined)}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={`${entry.relativePath}${entry.ignored ? " (ignored)" : ""}`}
            type="button"
          >
            <span className="tree-glyph">{isDir ? (node?.open ? "▾" : "▸") : entry.kind === "symlink" ? "↪" : "·"}</span>
            <span className="tree-name">{entry.name}</span>
            {!isDir && <span className="small muted">{formatBytes(entry.bytes)}</span>}
          </button>
          {isDir && node?.open && node.children && <ul className="tree">{renderEntries(node.children, depth + 1)}</ul>}
        </li>
      );
    });

  const editable = !!selected && selected.editable && !selected.truncated && !selected.binary;

  return (
    <div className="files-pane">
      <aside className="tree-pane">
        <div className="row">
          <label className="check small">
            <input checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} type="checkbox" /> show ignored
          </label>
          <button className="link small" onClick={() => void loadRoot()} type="button">
            refresh
          </button>
        </div>
        {rootEntries === null ? <p className="small muted">Loading…</p> : <ul className="tree">{renderEntries(rootEntries, 0)}</ul>}
        <p className="small muted">Ignore rules hide entries here only; agents still see every file.</p>
      </aside>
      <section className="viewer-pane">
        {!selected && <p className="muted">Select a file to view it.</p>}
        {selected && (
          <>
            <div className="row wrap">
              <span className="mono">{selected.relativePath}</span>
              <span className="chip small">{formatBytes(selected.bytes)}</span>
              <span className="chip small">{selected.totalLines} lines</span>
              {selected.crlf && <span className="chip small">CRLF</span>}
              {selected.binary && <span className="chip small chip-warn">binary</span>}
              <span className="chip small mono" title="Content hash used for checked saves">
                {selected.contentHash.slice(0, 12)}
              </span>
              <button className="button small" onClick={() => void openFile(selected.relativePath)} type="button">
                Reload
              </button>
              <button className="button small button-primary" disabled={!dirty || saving || !editable} onClick={() => void save()} type="button">
                {saving ? "Saving…" : dirty ? "Save (checked)" : "Saved"}
              </button>
              <span className="small muted">open in</span>
              {EDITORS.map((editor) => (
                <button className="link small" key={editor.id} onClick={() => void openExternal(editor.id)} type="button">
                  {editor.label}
                </button>
              ))}
            </div>
            {notice && <p className="small muted">{notice}</p>}
            {selected.binary ? (
              <p className="muted">Binary content is not shown. Open it in an external application.</p>
            ) : (
              <Suspense fallback={<textarea className="textarea editor" readOnly value={draft} />}>
                <CodeEditor
                  onChange={(value) => {
                    setDraft(value);
                    setDirty(value !== selected.content);
                  }}
                  path={selected.relativePath}
                  readOnly={!editable}
                  value={draft}
                />
              </Suspense>
            )}
          </>
        )}
      </section>
    </div>
  );
}
