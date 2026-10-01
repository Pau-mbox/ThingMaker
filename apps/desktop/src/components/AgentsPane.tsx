/**
 * Execution inspector (INS-01..03): the subagents an agent reported and the
 * tool calls it runs in the background. Everything here comes from the
 * agent's own update stream — Claude Code's `Agent`/`Task` calls, translated
 * by the supervisor into subagent events — and nothing is inferred.
 */
import { useStore } from "../store";
import { isBackground, type AgentNode } from "../projection";
import { JobsSection } from "./JobsSection";

function formatMs(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function AgentTree({ nodes, parentId, depth }: { nodes: AgentNode[]; parentId: string | null; depth: number }) {
  const children = nodes.filter((n) => (parentId === null ? n.parentId === null || !nodes.some((p) => p.id === n.parentId) : n.parentId === parentId));
  if (children.length === 0) return null;
  return (
    <ul className={`agent-tree ${depth === 0 ? "agent-tree-root" : ""}`}>
      {children.map((node) => {
        const running = node.status === "working" || node.status === "starting";
        const duration =
          node.generationFinishedAtUnixMs !== null ? node.generationFinishedAtUnixMs - node.generationStartedAtUnixMs : Date.now() - node.generationStartedAtUnixMs;
        return (
          <li key={node.id}>
            <div className="agent-row">
              <span className={`chip small ${running ? "chip-active" : node.outcome === "failed" ? "chip-warn" : ""}`}>{node.status}</span>
              <strong>{node.name}</strong>
              <span className="small muted">
                {node.harness}
                {/* "default" rather than nothing: the agent reporting no
                    selection means it chose, which is an answer. */}
                {` · ${node.model ?? "default"}`} · {formatMs(duration)}
                {node.outcome ? ` · ${node.outcome}` : ""}
              </span>
              {node.parentId !== null && !nodes.some((p) => p.id === node.parentId) && (
                <span className="chip small chip-warn" title={`parent ${node.parentId} was not reported`}>
                  parent unknown{node.parentName ? ` (${node.parentName})` : ""}
                </span>
              )}
            </div>
            {node.task && <p className="small agent-task">{node.task}</p>}
            <AgentTree depth={depth + 1} nodes={nodes} parentId={node.id} />
          </li>
        );
      })}
    </ul>
  );
}

export function AgentsPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  if (!session) return null;
  const { inspector, toolCalls, detached } = session.projection;
  const agents = [...inspector.agents.values()].sort((a, b) => a.createdAtUnixMs - b.createdAtUnixMs);
  // A subtree is finished only when nothing inside it is still running:
  // collapsing a done parent that still has a working child would hide the
  // one thing worth looking at.
  const working = (node: AgentNode) => node.status === "working" || node.status === "starting";
  const byId = new Map(agents.map((node) => [node.id, node] as const));
  const rootOf = (node: AgentNode): AgentNode => {
    const seen = new Set<string>();
    let cursor = node;
    while (cursor.parentId && byId.has(cursor.parentId) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId) as AgentNode;
    }
    return cursor;
  };
  const busyRoots = new Set(agents.filter(working).map((node) => rootOf(node).id));
  const live = agents.filter((node) => busyRoots.has(rootOf(node).id));
  const settled = agents.filter((node) => !busyRoots.has(rootOf(node).id));
  const backgroundCalls = [...toolCalls.values()].filter((p) => p.toolCallId && (isBackground(p) || detached.has(p.toolCallId)));

  return (
    <div className="agents-pane">
      <JobsSection sessionId={sessionId} />
      <section>
        <h3>Subagents</h3>
        {agents.length === 0 ? (
          <p className="small muted">No subagents have run in this session yet. They appear here as the agent starts them.</p>
        ) : (
          <>
            {live.length > 0 ? (
              <AgentTree depth={0} nodes={live} parentId={null} />
            ) : (
              <p className="small muted">Nothing is running right now.</p>
            )}
            {settled.length > 0 && (
              <details className="agent-settled">
                <summary className="small muted">
                  {settled.length} finished subagent{settled.length === 1 ? "" : "s"}
                </summary>
                <AgentTree depth={0} nodes={settled} parentId={null} />
              </details>
            )}
          </>
        )}
      </section>

      <section>
        <h3>Background calls</h3>
        {backgroundCalls.length === 0 ? (
          <p className="small muted">No tool calls running in the background.</p>
        ) : (
          <ul className="call-list">
            {backgroundCalls.map((patch) => {
              const id = patch.toolCallId as string;
              const detachedState = detached.get(id);
              return (
                <li className="card card-tool" key={id}>
                  <div className="agent-row">
                    <span className="chip small">{patch.toolKind ?? patch.name ?? "tool"}</span>
                    <strong>{patch.title ?? id}</strong>
                    <span className="chip small">{patch.status ?? "no status"}</span>
                    {detachedState && <span className="chip small">{detachedState.replace("_", " ")}</span>}
                  </div>
                  {patch.rawInput !== null && patch.rawInput !== undefined && (
                    <details>
                      <summary className="small">input (as reported)</summary>
                      <pre className="text">{typeof patch.rawInput === "string" ? patch.rawInput : JSON.stringify(patch.rawInput, null, 2)}</pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
