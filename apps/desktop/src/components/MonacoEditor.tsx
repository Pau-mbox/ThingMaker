/**
 * Monaco editor and diff editor (EDT-01/02). Loaded lazily so chat startup
 * never pays the editor cost; callers wrap this in `Suspense`. Monaco is a
 * browser editor here, not a VS Code extension host: no extensions run.
 */
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

// Vite bundles the worker as a separate chunk served from our own origin
// (CSP `worker-src 'self'`); no language services are loaded, only the core
// editor worker.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    json: "json",
    rs: "rust",
    py: "python",
    md: "markdown",
    toml: "ini",
    yaml: "yaml",
    yml: "yaml",
    css: "css",
    html: "html",
    sh: "shell",
    cs: "csharp",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] ?? "plaintext";
}

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "vs-dark",
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 12.5,
  scrollBeyondLastLine: false,
  renderWhitespace: "selection",
  wordWrap: "off",
};

export default function CodeEditor({
  value,
  path,
  readOnly,
  onChange,
}: {
  value: string;
  path: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;

  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.create(container.current, { ...OPTIONS, value, language: languageFor(path), readOnly });
    editor.current = instance;
    const subscription = instance.onDidChangeModelContent(() => changeHandler.current?.(instance.getValue()));
    return () => {
      subscription.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      editor.current = null;
    };
    // One editor instance per path; value and readOnly updates flow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div className="monaco" ref={container} />;
}

export function DiffEditor({ original, modified, path }: { original: string; modified: string; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const language = languageFor(path);
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(container.current, { ...OPTIONS, readOnly: true, renderSideBySide: true, originalEditable: false });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    return () => {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [original, modified, path]);
  return <div className="monaco" ref={container} />;
}
