/**
 * What a run is doing, and what it has done
 * (docs/plans/odyssey-observability.md §2, §3).
 *
 * Odyssey's own screen is a view of the record — what has settled — and the
 * transcript is a view of the stream. A long-horizon run lives between them:
 * it is mostly waiting, and "is it moving, on what, and why" was in neither
 * place. These two panels put it there.
 *
 * Nothing here is inferred. The run monitor reads the runtime's own reports
 * out of the projection, and the history renders rows the runner wrote to the
 * record before it acted on them.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { OdysseyJournalEntry, OdysseyView, Provider, SpendModel, UsageSnapshot, UsageWindow } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import type { AgentNode } from "../projection";
import { checkpointPaths } from "../odysseyReport";
import { staleActivity } from "../odysseyRunner";
import { windowName } from "./UsageLine";
import { IconAgents, IconAlertCircle, IconBox, IconBranch, IconCheckCircle, IconChevron, IconCode, IconMessage, IconTerminal } from "./icons";

function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * What is running an agent: its harness, and the model when the runtime named
 * one. A subagent delegated to an external harness does not inherit the
 * session's model, so "the one in the picker" is no longer a safe assumption.
 */
export function describeModel(agent: Pick<AgentNode, "harness" | "model">): string {
  if (agent.model) return `${agent.harness} · ${agent.model}`;
  // Null means the runtime reported no selection, so the harness chose — which
  // is a real answer, not missing data.
  return `${agent.harness} · default`;
}

/** The tail of the agent's latest message: the cheapest "what is it doing". */
function latestLine(cards: { kind: string }[]): { text: string; thinking: boolean } | null {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index] as { kind: string; message?: { role: string; blocks: { type: string; text?: string }[] } };
    if (card.kind !== "message" || !card.message) continue;
    if (card.message.role !== "agent" && card.message.role !== "thought") continue;
    const text = card.message.blocks
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n")
      .trim();
    if (!text) continue;
    const line = text.split("\n").filter(Boolean).at(-1) ?? "";
    if (!line) continue;
    return { text: line.length > 160 ? `${line.slice(0, 159)}…` : line, thinking: card.message.role === "thought" };
  }
  return null;
}

/**
 * The live section of the state card: what this turn is for, what is running
 * under it, and which subagents are working on what.
 *
 * Absent rather than empty when nothing is running — an empty panel that is
 * always there teaches you to stop reading it.
 */
export function RunMonitor({ sessionId, view }: { sessionId: string; view: OdysseyView }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const setSessionTab = useStore((s) => s.setSessionTab);
  const [now, setNow] = useState(Date.now());

  const projection = session?.projection;
  const foreground = projection?.foreground === "running" || projection?.foreground === "cancelling" || projection?.foreground === "awaiting_user";
  const tools = projection ? [...projection.toolCalls.values()].filter((tool) => tool.status === "in_progress" || tool.status === "pending") : [];
  const agents = projection ? [...projection.inspector.agents.values()].filter((agent) => agent.status === "working" || agent.status === "starting") : [];
  const detached = projection ? [...projection.detached.entries()].filter(([, state]) => state === "active" || state === "cancellation_requested") : [];
  const busy = foreground || agents.length > 0 || detached.length > 0;

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!session || !projection || !busy) return null;

  // The same honesty as the activity strip: work whose process died never
  // reports that it stopped, so a silent session is not a working one.
  const stale = foreground ? null : staleActivity({ lastEventAt: session.lastEventAt, now });

  // The milestone the runner is working: the first one not yet settled.
  const index = view.milestones.findIndex((milestone) => milestone.state === "active" || milestone.state === "reported" || milestone.state === "failed" || milestone.state === "planned");
  const milestone = index < 0 ? null : view.milestones[index];
  const startedAt = session.turnStartedAt;
  const line = latestLine(projection.cards);

  return (
    <div className="odyssey-monitor">
      <div className="odyssey-monitor-head">
        {stale ? <span className="activity-stale-dot" /> : <span className="spinner" />}
        <strong className="small">{milestone ? `Milestone ${index + 1}/${view.milestones.length} · ${milestone.title}` : "Working"}</strong>
        {startedAt !== null && <span className="small muted">{elapsed(now - startedAt)}</span>}
        <button className="link small" onClick={() => setSessionTab("transcript")} type="button">
          in transcript →
        </button>
      </div>

      <ul className="odyssey-monitor-list">
        {tools.map((tool) => (
          <li key={tool.toolCallId ?? tool.title ?? Math.random()}>
            <IconTerminal size={12} />
            <span className="small">{tool.title ?? tool.name ?? "tool call"}</span>
            <span className="small muted">{tool.status}</span>
          </li>
        ))}
        {agents.map((agent) => (
          <li key={agent.id}>
            <IconAgents size={12} />
            <span className="small">{agent.name}</span>
            {/* Which account is paying for this one. With subagents delegated
                to another harness, the model is no longer implied by the
                session's own picker. */}
            <span className="small muted mono">{describeModel(agent)}</span>
            <span className="small muted">
              {agent.status} · {elapsed(now - agent.generationStartedAtUnixMs)}
            </span>
            {agent.task && <span className="small muted odyssey-monitor-task">{agent.task}</span>}
          </li>
        ))}
        {detached.map(([call]) => (
          <li key={call}>
            <IconCode size={12} />
            <span className="small">background call</span>
            <span className="small mono muted">{call}</span>
          </li>
        ))}
      </ul>

      {stale && (
        <p className="small chip-warn odyssey-monitor-line">
          Nothing has been reported for {elapsed(stale.silentMs)}. What is listed above probably ended without saying so.
        </p>
      )}
      {line && (
        <p className="small muted odyssey-monitor-line" title={line.text}>
          {line.thinking ? "thinking: " : ""}
          {line.text}
        </p>
      )}
    </div>
  );
}

/** How each journal kind reads, and what it looks like. */
type KindStyle = { label: string; icon: (props: { size?: number }) => ReactElement; tone?: "warn" };

const KIND: Record<string, KindStyle> = {
  briefing: { label: "briefed", icon: IconMessage },
  continuation: { label: "continued", icon: IconMessage },
  plan: { label: "plan", icon: IconBox },
  checkpoint: { label: "checkpoint", icon: IconBranch },
  report: { label: "reported", icon: IconMessage },
  check: { label: "check", icon: IconCheckCircle },
  wait: { label: "waiting", icon: IconAlertCircle, tone: "warn" },
  resume: { label: "resumed", icon: IconCheckCircle },
  guard: { label: "guard", icon: IconAlertCircle, tone: "warn" },
  state: { label: "state", icon: IconCode },
};

function HistoryRow({ entry }: { entry: OdysseyJournalEntry }) {
  const kind: KindStyle = KIND[entry.kind] ?? { label: entry.kind, icon: IconCode };
  const Icon = kind.icon;
  const body = (
    <span className="odyssey-history-main">
      <span className="small muted odyssey-history-time">{timeOf(entry.at)}</span>
      <Icon size={12} />
      <span className={`small odyssey-history-kind ${kind.tone === "warn" ? "chip-warn-text" : ""}`}>{kind.label}</span>
      <span className="small odyssey-history-summary">{entry.summary}</span>
    </span>
  );
  // A checkpoint's detail is the guard's fingerprint and then the paths this
  // turn changed; the fingerprint is not for reading.
  const paths = entry.kind === "checkpoint" ? checkpointPaths(entry.detail) : null;
  if (!entry.detail || (paths !== null && paths.length === 0)) return <li className="odyssey-history-row">{body}</li>;
  return (
    <li className="odyssey-history-row">
      <details>
        <summary>
          {body}
          <IconChevron size={11} />
        </summary>
        {paths ? (
          <ul className="odyssey-history-paths">
            {paths.map((path) => (
              <li className="small mono" key={path}>
                {path}
              </li>
            ))}
          </ul>
        ) : (
          <pre className="text odyssey-history-detail">{entry.detail}</pre>
        )}
      </details>
    </li>
  );
}

/**
 * What the run's own usage samples say the subscription window charges
 * (docs/research/odyssey-review.md §4.1). One line, because the answer is
 * one sentence; the numbers behind it are in the record.
 */
export function SpendModelNote({ odysseyId, refreshKey }: { odysseyId: string; refreshKey: number }) {
  const [model, setModel] = useState<SpendModel | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .odysseySpendModel(odysseyId)
      .then((value) => {
        if (!cancelled) setModel(value);
      })
      .catch(() => {
        if (!cancelled) setModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [odysseyId, refreshKey]);
  if (!model) return null;
  return (
    <p className="small muted odyssey-spend" title={`${model.samples} samples, ${model.pairs} usable pairs`}>
      Spend model: {model.note}
    </p>
  );
}

/**
 * The run's history, newest first.
 *
 * Every one of these rows was already written to the record before the runner
 * acted on it; until now exactly one line of it was rendered. Checkpoints are
 * hidden by default because there is one per turn and they say the least.
 */
export function RunHistory({ journal }: { journal: OdysseyJournalEntry[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? journal : journal.filter((entry) => entry.kind !== "checkpoint");
  // Counted from the journal, not from the difference: once they are shown the
  // difference is zero and the toggle would vanish with no way back.
  const checkpoints = journal.filter((entry) => entry.kind === "checkpoint").length;

  return (
    <section className="card odyssey-history">
      <header className="work-head">
        <span className="work-title">History</span>
        {checkpoints > 0 && (
          <button className="link small" onClick={() => setAll(!all)} type="button">
            {all ? "hide checkpoints" : `show ${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"}`}
          </button>
        )}
      </header>
      {shown.length === 0 ? (
        <p className="small muted">Nothing recorded yet.</p>
      ) : (
        <ol className="odyssey-history-list">
          {shown.map((entry) => (
            <HistoryRow entry={entry} key={entry.id} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** When a window comes back, said as a clock time or a date if it is far off. */
function resetLabel(window: UsageWindow, now: number): string | null {
  const at = window.resetAtUnix !== undefined ? window.resetAtUnix * 1000 : window.resetAfterSeconds !== undefined ? now + window.resetAfterSeconds * 1000 : null;
  if (at === null) return null;
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay
    ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * What is left on the account, in absolute terms.
 *
 * The card could say "usage is spent" while showing no numbers, so there was
 * no way to tell whether Odyssey was reading the same thing the provider's own
 * meter showed. These are the numbers the wait is decided from.
 */
export function UsageWindows({ usage, agent = "codex" }: { usage: UsageSnapshot | null | undefined; agent?: Provider }) {
  const refreshUsage = useStore((s) => s.refreshUsage);
  // "Check now" has to ask the account this run actually spends: a check
  // against the wrong subscription is the one control for getting unstuck
  // fetching a number that has nothing to do with the run.
  const refresh = () => refreshUsage(agent);
  const [checking, setChecking] = useState(false);
  const now = Date.now();

  const windows = [usage?.primary, usage?.secondary].filter((window): window is UsageWindow => !!window);
  if (!usage || windows.length === 0) {
    return (
      <p className="small muted">
        Usage has not been sampled.{" "}
        <button className="link small" onClick={() => void refresh()} type="button">
          check now
        </button>
      </p>
    );
  }

  return (
    <div className="odyssey-usage">
      {windows.map((window) => {
        const left = Math.max(0, 100 - window.usedPercent);
        const reset = resetLabel(window, now);
        return (
          <div className="odyssey-usage-row" key={window.windowSeconds}>
            <span className="small muted">{windowName(window.windowSeconds)}</span>
            <span className={`small ${left === 0 ? "chip-warn-text" : ""}`}>{left}% left</span>
            {reset && <span className="small muted">resets {reset}</span>}
          </div>
        );
      })}
      <div className="odyssey-usage-row">
        <span className="small muted">
          {agent === "claude" && usage.limitReached ? (
            <>
              refused {elapsed(now - usage.fetchedAtUnixMs)} ago
              {/* Said plainly, because this account reports no percentage at
                  all: the bar above is what the refusal implied, not a
                  reading, and the run retries without waiting for the clock. */}
              {" · this is what the refusal said, not a measurement; the run tries again every few minutes"}
            </>
          ) : (
            <>
              sampled {elapsed(now - usage.fetchedAtUnixMs)} ago
              {usage.limitReached ? " · the provider reported the limit was reached" : ""}
            </>
          )}
        </span>
        <button
          className="link small"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void refresh().finally(() => setChecking(false));
          }}
          type="button"
        >
          {checking ? "checking…" : "check now"}
        </button>
      </div>
    </div>
  );
}
