/**
 * Background tasks: commands an agent left running after its turn ended —
 * a build, a dev server, a long test run. Nothing on the transcript says
 * they are still going once the turn has settled, so the session bar keeps
 * an icon for them: a green dot while any runs, a grey one once they have
 * all ended, none when there have been none. It opens a small window with
 * each one's command, state and output.
 *
 * The session's side transcript is a session of its own; its commands are
 * listed here too, marked as its.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundOutput, BackgroundTask } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { t } from "../i18n";

type Listed = BackgroundTask & { sessionId: string; side: boolean };

/** How long, said the way the activity strip says it. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateWord(task: BackgroundTask): string {
  switch (task.state) {
    case "running":
      return t("Running");
    case "completed":
      return t("Finished");
    case "failed":
      return task.exitCode !== undefined ? t("Failed (exit {code})", { code: task.exitCode }) : t("Failed");
    case "stopped":
      return t("Stopped");
  }
}

/** The tasks of a session and of its side transcript, newest first. */
export function useBackgroundTasks(sessionId: string): Listed[] {
  const sideId = useStore((s) => s.sides[sessionId]);
  const main = useStore((s) => s.sessions[sessionId]);
  const side = useStore((s) => (sideId ? s.sessions[sideId] : undefined));
  return useMemo(() => {
    const tasks: Listed[] = [];
    for (const task of main?.projection.background.values() ?? []) tasks.push({ ...task, sessionId, side: false });
    if (sideId) for (const task of side?.projection.background.values() ?? []) tasks.push({ ...task, sessionId: sideId, side: true });
    return tasks.sort((a, b) => b.startedAtUnixMs - a.startedAtUnixMs);
  }, [main, side, sessionId, sideId]);
}

/** The session bar's icon, and the window it opens. */
export function BackgroundTasksButton({ sessionId }: { sessionId: string }) {
  const tasks = useBackgroundTasks(sessionId);
  const running = tasks.filter((task) => task.state === "running").length;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const onDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setAt(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setAt(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [at]);

  const label =
    running > 0
      ? running === 1
        ? t("Background tasks: 1 running")
        : t("Background tasks: {n} running", { n: running })
      : tasks.length > 0
        ? t("Background tasks: all ended")
        : t("Background tasks");

  return (
    <>
      <button
        aria-expanded={at !== null}
        aria-haspopup="dialog"
        aria-label={label}
        className={`icon-button icon-button-xs tab-icon ${at ? "on" : ""}`}
        onClick={() => {
          if (at) return setAt(null);
          const rect = trigger.current?.getBoundingClientRect();
          if (rect) setAt({ x: rect.right - 440, y: rect.bottom + 4 });
        }}
        ref={trigger}
        title={label}
        type="button"
      >
        <IconBackgroundTasks size={15} />
        {tasks.length > 0 && <span aria-hidden="true" className={`badge-dot ${running > 0 ? "badge-dot-running" : "badge-dot-ended"}`} />}
      </button>
      {at && (
        <div aria-label={t("Background tasks")} className="context-menu bg-tasks" ref={panel} role="dialog" style={{ left: Math.max(8, at.x), top: at.y }}>
          <header className="bg-tasks-head">
            <strong>{t("Background tasks")}</strong>
            <span className="small muted">{running > 0 ? (running === 1 ? t("1 running") : t("{n} running", { n: running })) : tasks.length > 0 ? t("none running") : ""}</span>
          </header>
          {tasks.length === 0 ? (
            <p className="small muted bg-tasks-empty">{t("No background tasks in this session yet. Commands the agent leaves running after its turn show up here.")}</p>
          ) : (
            <ul className="bg-tasks-list">
              {tasks.map((task) => (
                <TaskRow key={`${task.sessionId}|${task.taskId}`} task={task} />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function TaskRow({ task }: { task: Listed }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const running = task.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const took = (task.endedAtUnixMs ?? now) - task.startedAtUnixMs;
  const when = running ? t("for {time}", { time: duration(took) }) : t("took {time} · ended {ago} ago", { time: duration(took), ago: duration(now - (task.endedAtUnixMs ?? now)) });
  return (
    <li className={`bg-task bg-task-${task.state}`}>
      <button aria-expanded={open} className="bg-task-head" onClick={() => setOpen(!open)} type="button">
        <span aria-hidden="true" className="bg-task-mark" />
        <span className="bg-task-what">
          <span className="mono bg-task-command" title={task.command}>
            {task.command ?? task.description ?? task.taskId}
          </span>
          <span className="small muted">
            {stateWord(task)} {when}
            {task.description && task.command ? ` · ${task.description}` : ""}
            {task.side ? ` · ${t("Side Transcript")}` : ""}
          </span>
        </span>
      </button>
      {open && <TaskOutput task={task} />}
    </li>
  );
}

/** The end of a task's output, read from its file while it is open, and
 *  again every two seconds while the command runs. */
function TaskOutput({ task }: { task: Listed }) {
  const handle = useStore((s) => s.sessions[task.sessionId]?.handle);
  const [output, setOutput] = useState<BackgroundOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = task.state === "running";
  useEffect(() => {
    if (!handle) return;
    let current = true;
    const read = () =>
      api
        .sessionBackgroundOutput(handle, task.taskId)
        .then((next) => {
          if (current) {
            setOutput(next);
            setError(null);
          }
        })
        .catch((reason: { message?: string }) => current && setError(reason?.message ?? String(reason)));
    void read();
    const timer = running ? setInterval(() => void read(), 2000) : null;
    return () => {
      current = false;
      if (timer) clearInterval(timer);
    };
  }, [handle, task.taskId, running]);
  const shown = output ? new TextEncoder().encode(output.text).length : 0;
  return (
    <div className="bg-task-output">
      {error ? (
        <p className="small muted">{error}</p>
      ) : output ? (
        <>
          {output.bytes > shown && <p className="small muted">{t("The last {shown} KB of {total} KB.", { shown: Math.round(shown / 1024), total: Math.round(output.bytes / 1024) })}</p>}
          <pre className="text">{output.text || t("(no output yet)")}</pre>
        </>
      ) : (
        <p className="small muted">{t("Reading its output…")}</p>
      )}
      {task.outputPath && (
        <p className="small muted mono bg-task-path" title={task.outputPath}>
          {task.outputPath}
        </p>
      )}
    </div>
  );
}

/** Two windows, one behind the other: work going on out of sight. */
function IconBackgroundTasks({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} viewBox="0 0 24 24" width={size}>
      <path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
      <rect height="12" rx="2" width="12" x="4" y="8" />
      <path d="m7.5 12.5 2 1.5-2 1.5" />
    </svg>
  );
}
