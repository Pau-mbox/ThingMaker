/**
 * Interactive terminal (TERM-01..03): a native PTY in the supervisor, xterm.js
 * in the renderer. The terminal is a user tool with the same authority as the
 * user's shell; it is not a sandbox and never carries ACP traffic.
 *
 * Hardening: no link or clipboard addons; multi-line pastes are confirmed
 * before being written; closing a live shell is confirmed; exports go through
 * a redaction preview and the native save dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent, TerminalInfo } from "@thingmaker/contracts";
import { api } from "../ipc";
import { redactText, type Redaction } from "../redact";
import { useStore } from "../store";

const SCROLLBACK_LINES = 5000;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type PendingPaste = { text: string; lines: number };
type ExportPreview = { text: string; redactions: Redaction[] };

export function TerminalPane({ workspaceId }: { workspaceId: string }) {
  const setError = useStore((s) => s.setError);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null);
  const [connecting, setConnecting] = useState(true);

  // Discover an existing terminal for this workspace (survives tab switches
  // and renderer reloads; the supervisor replays scrollback on subscribe).
  useEffect(() => {
    let cancelled = false;
    setConnecting(true);
    api
      .terminalList()
      .then((entries) => {
        if (cancelled) return;
        const mine = entries.find((e) => e.workspaceId === workspaceId && !e.info.exited);
        setInfo(mine ? mine.info : null);
      })
      .catch((error: unknown) => setError(error))
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, setError]);

  // Mount xterm and stream once a terminal exists.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !info) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      allowProposedApi: false,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    const id = info.id;
    let disposed = false;

    const dataDisposable = term.onData((data) => {
      api.terminalWrite(id, data).catch((error: unknown) => setError(error));
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      api.terminalResize(id, cols, rows).catch(() => undefined);
    });
    // Intercept DOM pastes: single-line pastes go straight through; anything
    // with a newline would execute commands and is confirmed first.
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      if (/[\r\n]/.test(text)) {
        setPendingPaste({ text, lines: text.split(/\r\n|\r|\n/).length });
      } else {
        term.paste(text);
      }
    };
    host.addEventListener("paste", onPaste, true);

    api
      .terminalSubscribe(id, (event: TerminalEvent) => {
        if (disposed) return;
        if (event.type === "output") term.write(decodeBase64(event.dataBase64));
        else {
          term.write(`\r\n\x1b[2m[process exited${event.code === null ? "" : ` with code ${event.code}`}]\x1b[0m\r\n`);
          setInfo((current) => (current && current.id === id ? { ...current, exited: true, exitCode: event.code } : current));
        }
      })
      .catch((error: unknown) => setError(error));

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Host not laid out yet.
      }
    });
    observer.observe(host);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
      term.focus();
    });

    return () => {
      disposed = true;
      observer.disconnect();
      host.removeEventListener("paste", onPaste, true);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [info?.id, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(async () => {
    setConnecting(true);
    try {
      const host = hostRef.current;
      const cols = Math.max(20, Math.floor((host?.clientWidth ?? 800) / 8));
      const rows = Math.max(5, Math.floor((host?.clientHeight ?? 400) / 17));
      const opened = await api.terminalOpen(workspaceId, cols, rows);
      setInfo(opened.info);
      setNote(opened.environmentNote);
    } catch (error) {
      setError(error);
    } finally {
      setConnecting(false);
    }
  }, [workspaceId, setError]);

  const close = useCallback(async () => {
    if (!info) return;
    try {
      await api.terminalClose(info.id);
    } catch (error) {
      setError(error);
    }
    setConfirmClose(false);
    setInfo(null);
  }, [info, setError]);

  const requestClose = () => {
    if (info && !info.exited) setConfirmClose(true);
    else void close();
  };

  const startExport = async () => {
    if (!info) return;
    try {
      const raw = await api.terminalExport(info.id);
      const cleaned = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\r/g, "");
      setExportPreview(redactText(cleaned));
    } catch (error) {
      setError(error);
    }
  };

  const saveExport = async (redacted: boolean) => {
    if (!exportPreview || !info) return;
    try {
      const content = redacted ? exportPreview.text : (await api.terminalExport(info.id)).replace(/\r/g, "");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await api.saveTextFile(`terminal-${stamp}.log`, content);
    } catch (error) {
      setError(error);
    }
    setExportPreview(null);
  };

  return (
    <div className="terminal-pane">
      <div className="row wrap terminal-toolbar">
        {info ? (
          <>
            <span className="chip mono small" title={info.cwd}>
              {info.program} · {info.exited ? `exited${info.exitCode === null ? "" : ` (${info.exitCode})`}` : `pid ${info.pid ?? "?"}`}
            </span>
            <button className="button" onClick={() => void startExport()} type="button">
              Export log…
            </button>
            <button className="button button-warn" onClick={requestClose} type="button">
              {info.exited ? "Dismiss" : "Close terminal"}
            </button>
          </>
        ) : (
          <button className="button button-primary" disabled={connecting} onClick={() => void open()} type="button">
            {connecting ? "Connecting…" : "Open terminal"}
          </button>
        )}
        <span className="chip small chip-warn">Trusted local - host access</span>
      </div>
      {note && <p className="small muted">{note}</p>}
      {!info && !connecting && (
        <p className="small muted">
          A login shell starts in the workspace root with the same environment profile agents get. It runs with your full user authority; nothing here is sandboxed.
        </p>
      )}
      <div className={`terminal-host ${info ? "" : "terminal-host-empty"}`} ref={hostRef} />

      {pendingPaste && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal">
            <h2>Paste {pendingPaste.lines} lines?</h2>
            <p className="small muted">Multi-line pastes run each line as a command as soon as the shell reads them. Review before continuing.</p>
            <pre className="text paste-preview">{pendingPaste.text.slice(0, 4000)}</pre>
            <div className="row wrap">
              <button
                className="button button-primary"
                onClick={() => {
                  termRef.current?.paste(pendingPaste.text);
                  setPendingPaste(null);
                }}
                type="button"
              >
                Paste
              </button>
              <button
                className="button"
                onClick={() => {
                  termRef.current?.paste(pendingPaste.text.replace(/\r\n|\r|\n/g, " "));
                  setPendingPaste(null);
                }}
                type="button"
              >
                Paste as one line
              </button>
              <button className="button" onClick={() => setPendingPaste(null)} type="button">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClose && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal">
            <h2>Close the running shell?</h2>
            <p className="small muted">The shell and any foreground command it is running are terminated.</p>
            <div className="row wrap">
              <button className="button button-warn" onClick={() => void close()} type="button">
                Close terminal
              </button>
              <button className="button" onClick={() => setConfirmClose(false)} type="button">
                Keep it
              </button>
            </div>
          </div>
        </div>
      )}

      {exportPreview && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal modal-wide">
            <h2>Export terminal log</h2>
            <p className="small muted">
              {exportPreview.redactions.length === 0
                ? "No secret-looking text was detected. Review the log before saving; detection is best effort."
                : `Redacted: ${exportPreview.redactions.map((r) => `${r.count} ${r.label}`).join(", ")}. Review before saving; detection is best effort.`}
            </p>
            <pre className="text paste-preview">{exportPreview.text.slice(-20000)}</pre>
            <div className="row wrap">
              <button className="button button-primary" onClick={() => void saveExport(true)} type="button">
                Save redacted…
              </button>
              <button className="button" onClick={() => void saveExport(false)} type="button">
                Save unredacted…
              </button>
              <button className="button" onClick={() => setExportPreview(null)} type="button">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
