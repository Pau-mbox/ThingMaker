/**
 * Context and usage (CTX-01..04).
 *
 * Configured sources come from disk (instruction files, skills) and are
 * labelled as configured. Agent-reported facts (context used/size, token
 * counters, the account's quota) come from the agent's own updates and are
 * labelled as reported. The two are never merged into a
 * claim about what is "in context" right now.
 */
import { useEffect, useState } from "react";
import type { ContextBundle, ContextSources, Mention, TranscriptUsage } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore, windowDelta as windowDeltaOf } from "../store";
import { cacheEfficiency, percent } from "../usage";
import { UsageLine, signed, windowName } from "./UsageLine";

const EMPTY_LIST: never[] = [];

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function unknown(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : value.toLocaleString();
}

export function ContextPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const setError = useStore((s) => s.setError);
  const setView = useStore((s) => s.setView);
  const bundles = useStore((s) => (session ? s.contextBundles[session.workspaceId] : undefined));
  const loadBundles = useStore((s) => s.loadContextBundles);
  const saveBundle = useStore((s) => s.saveContextBundle);
  const deleteBundle = useStore((s) => s.deleteContextBundle);
  const applyBundle = useStore((s) => s.applyContextBundle);
  const mentions = useStore((s) => s.mentions[sessionId] ?? EMPTY_LIST);
  const draft = useStore((s) => s.drafts[sessionId] ?? "");
  const provider = session?.snapshot.provider ?? "claude";
  const account = useStore((s) => s.usage[provider] ?? null);
  const quota = useStore((s) => s.quotas[provider]);
  const [sources, setSources] = useState<ContextSources | null>(null);
  const [name, setName] = useState("");
  const [usage, setUsage] = useState<TranscriptUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  const agentSessionId = session?.snapshot.agentSessionId ?? null;
  const settledCount = session?.projection.settledTurns ?? 0;

  useEffect(() => {
    if (!session || !agentSessionId) return;
    api
      .sessionTokenUsage(session.workspaceId, agentSessionId)
      .then((u) => {
        setUsage(u);
        setUsageError(null);
      })
      .catch((error: unknown) => setUsageError(typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error)));
  }, [session?.workspaceId, agentSessionId, settledCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return;
    api.contextSources(session.workspaceId).then(setSources).catch(setError);
    void loadBundles(session.workspaceId);
  }, [session?.workspaceId, setError, loadBundles]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return null;
  const { projection } = session;
  const model = (() => {
    const options = projection.configOptions ?? session.snapshot.configOptions;
    if (!Array.isArray(options)) return null;
    const option = (options as { id?: string; currentValue?: unknown }[]).find((o) => o.id === "model");
    return option?.currentValue === undefined ? null : String(option.currentValue);
  })();

  const saveCurrentAsBundle = () => {
    if (!name.trim()) return;
    const bundle: ContextBundle = { id: crypto.randomUUID(), name: name.trim(), instructions: draft, refs: mentions as Mention[] };
    void saveBundle(session.workspaceId, bundle);
    setName("");
  };

  const resetAfter = (resetAtUnix: number | undefined) => (resetAtUnix === undefined ? undefined : Math.max(0, resetAtUnix - Math.floor(Date.now() / 1000)));
  const resetIn = (seconds: number | undefined) => {
    if (seconds === undefined) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h >= 48 ? `resets in ${Math.round(h / 24)} d` : h > 0 ? `resets in ${h} h ${m} min` : `resets in ${m} min`;
  };
  const su = session.usage;
  const primaryName = windowName(account?.primary?.windowSeconds);
  const secondaryName = windowName(account?.secondary?.windowSeconds);

  return (
    <div className="context-pane">
      <section>
        <h3>{PROVIDER_LABELS[provider]} subscription usage</h3>
        {!account && !quota && (
          <p className="small muted">
            Nothing reported yet. {PROVIDER_LABELS[provider]} reports its account&rsquo;s quota as the session works; it appears here after the first turn.
          </p>
        )}
        {!account && quota && quota.status !== "rejected" && (
          <p className="small muted">
            The account reports {quota.status === "warning" ? "that it is close to a limit" : "room"}
            {quota.windows[0] ? ` on its ${quota.windows[0].kind.replace(/_/g, " ")} window` : ""}, without a percentage.
          </p>
        )}
        {account && (
          <div className="row wrap">
            {account.primary && (
              <span className={`chip ${account.primary.usedPercent >= 90 ? "chip-warn" : ""}`} title={resetIn(resetAfter(account.primary.resetAtUnix))}>
                {primaryName} window: {Math.max(0, 100 - Math.round(account.primary.usedPercent))}% left ({Math.round(account.primary.usedPercent)}% used) · {resetIn(resetAfter(account.primary.resetAtUnix))}
              </span>
            )}
            {account.secondary && (
              <span className={`chip ${account.secondary.usedPercent >= 90 ? "chip-warn" : ""}`} title={resetIn(resetAfter(account.secondary.resetAtUnix))}>
                {secondaryName} window: {Math.max(0, 100 - Math.round(account.secondary.usedPercent))}% left ({Math.round(account.secondary.usedPercent)}% used) · {resetIn(resetAfter(account.secondary.resetAtUnix))}
              </span>
            )}
            {account.planType && <span className="chip">{account.planType}</span>}
            {account.limitReached && <span className="chip chip-warn">limit reached</span>}
          </div>
        )}
        {account && (
          <>
            <div className="row wrap">
              <span className="chip chip-active">
                this session used: {primaryName} {signed(su.totalPrimary)} · {secondaryName} {signed(su.totalSecondary)} · {su.turns} turn{su.turns === 1 ? "" : "s"}
              </span>
              {su.resets > 0 && <span className="chip chip-warn">{su.resets} window reset(s) excluded</span>}
            </div>
            {su.lastTurn && <UsageLine label="Last turn" primary={su.lastTurn.primary} primaryName={primaryName} secondary={su.lastTurn.secondary} secondaryName={secondaryName} />}
            {su.turnStart && su.latest && (
              <UsageLine label="Current turn so far" primary={windowDeltaOf(su.turnStart.primary, su.latest.primary)} primaryName={primaryName} secondary={windowDeltaOf(su.turnStart.secondary, su.latest.secondary)} secondaryName={secondaryName} sampling={su.sampling} />
            )}
            {su.error && <p className="small chip-warn">Last sample failed: {su.error}</p>}
          </>
        )}
        <p className="small muted">
          As {PROVIDER_LABELS[provider]} reports it, account-wide: everything else using the subscription during a turn (other sessions, the provider&rsquo;s own
          apps) lands in the same numbers. Session totals sum the per-turn differences since the session was attached in this app run; a window that resets
          mid-turn is excluded rather than guessed.
        </p>
      </section>

      <section>
        <h3>Reported by the agent</h3>
        <div className="row wrap">
          <span className="chip">context used: {unknown(projection.usage?.used)} / window: {unknown(projection.usage?.size)}</span>
          {projection.tokens && (
            <span className="chip">
              wire counters: in {unknown(projection.tokens.input)} · out {unknown(projection.tokens.output)} · total {unknown(projection.tokens.total)}
            </span>
          )}
          {model && <span className="chip">model (live option): {model}</span>}
        </div>
        <p className="small muted">
          The agent reports the context used and the window size as it works; per-call token counts are not on the wire. The figures below are
          read from the agent's own transcript on disk.
        </p>
        <h4>Token usage from the agent&rsquo;s transcript</h4>
        {usageError && <p className="small chip-warn">{usageError}</p>}
        {usage && (
          <>
            <div className="row wrap">
              <span className="chip" title="Model responses. A response written several times is folded back into one.">
                model responses: {usage.totals.calls}
                {usage.totals.foldedItems > 0 ? ` (${usage.totals.calls + usage.totals.foldedItems} transcript items)` : ""}
              </span>
              <span className="chip">input: {usage.totals.inputTokens.toLocaleString()}</span>
              <span className="chip">output: {usage.totals.outputTokens.toLocaleString()}</span>
              <span className="chip">total: {(usage.totals.inputTokens + usage.totals.outputTokens).toLocaleString()}</span>
              <span className="chip">reasoning: {usage.totals.reasoningTokens.toLocaleString()}{usage.totals.partial ? "+" : ""}</span>
              <span className="chip">cached input (subset of input): {usage.totals.cachedInputTokens.toLocaleString()}{usage.totals.partial ? "+" : ""}</span>
              {usage.totals.cacheWriteInputTokens > 0 && <span className="chip">cache write: {usage.totals.cacheWriteInputTokens.toLocaleString()}</span>}
              <span className="chip">cost: {usage.calls.some((c) => c.cost !== undefined) ? "reported by the agent" : "not reported"}</span>
            </div>
            <div className="row wrap">
              {(() => {
                const cache = cacheEfficiency(usage.totals);
                if (!cache)
                  return (
                    <span className="chip muted" title="A prefix has to be re-sent at least once before there is anything a cache could have served.">
                      prompt cache: not measurable yet
                    </span>
                  );
                return (
                  <>
                    <span
                      className={cache.missedShare > 0.2 ? "chip chip-warn" : "chip"}
                      title="Prefix this session sent more than once, and how much of it the provider did not serve from its prompt cache. runtime/patches/0001 does."
                    >
                      re-sent prefix missed by cache: {cache.missedPrefixTokens.toLocaleString()} / {cache.cacheablePrefixTokens.toLocaleString()} ({percent(cache.missedShare)})
                      {cache.estimate ? " (estimate)" : ""}
                    </span>
                    <span className="chip" title="Input tokens the provider did not serve from cache: the part billed at full rate.">
                      paid input: {cache.paidInputTokens.toLocaleString()}
                      {cache.missedShareOfPaid === null ? "" : ` (${percent(cache.missedShareOfPaid)} of it a cache miss)`}
                    </span>
                  </>
                );
              })()}
            </div>
            <p className="small muted">
              Read from <span className="mono">{usage.path}</span> ({usage.lines} lines{usage.parseErrors > 0 ? `, ${usage.parseErrors} unparsable` : ""}, schema {usage.schemaVersions.join("/") || "?"}).
              Input includes cached input; reasoning tokens are counted inside output by the provider. Refreshes when a turn settles.
            </p>
            <button className="link small" onClick={() => setShowCalls(!showCalls)} type="button">
              {showCalls ? "hide" : "show"} per-call breakdown
            </button>
            {showCalls && (
              <table className="config-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Item</th>
                    <th>Input</th>
                    <th>Cached</th>
                    <th>Output</th>
                    <th>Reasoning</th>
                    <th>Missed prefix</th>
                    <th>Context window</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.calls.map((c, i) => (
                    <tr key={`${c.generation}-${c.itemId}`}>
                      <td>{i + 1}</td>
                      <td className="mono" title={[c.createdAt, ...(c.foldedItemIds ?? [])].filter(Boolean).join(" ")}>
                        {c.kind} {c.itemId.slice(0, 8)}
                        {c.foldedItemIds?.length ? ` +${c.foldedItemIds.length}` : ""}
                      </td>
                      <td>{c.inputTokens.toLocaleString()}</td>
                      <td>{c.cachedInputTokens?.toLocaleString() ?? "unknown"}</td>
                      <td>{c.outputTokens.toLocaleString()}</td>
                      <td>{c.reasoningTokens?.toLocaleString() ?? "unknown"}</td>
                      <td title={c.missedPrefixTokens === undefined ? "No earlier prefix to reuse, or no cached figure reported." : undefined}>
                        {c.missedPrefixTokens?.toLocaleString() ?? "—"}
                      </td>
                      <td>{c.contextWindow?.toLocaleString() ?? "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {!usage && !usageError && <p className="small muted">Reading the agent&rsquo;s transcript…</p>}
      </section>

      <section>
        <h3>Configured on disk</h3>
        {!sources ? (
          <p className="muted">Reading configuration…</p>
        ) : (
          <>
            <dl className="facts">
              <dt>Effective root</dt>
              <dd className="mono">{sources.root}</dd>
              <dt>Instruction files (AGENTS.md and CLAUDE.md, nearest first)</dt>
              <dd>
                {sources.instructionFiles.length === 0 ? (
                  <span className="muted small">none found at the root or its ancestors</span>
                ) : (
                  <ul className="call-list">
                    {sources.instructionFiles.map((f) => (
                      <li className="small" key={f.path}>
                        <span className="mono">{f.path}</span> · {bytes(f.bytes)} · blake3 {f.contentHash.slice(0, 12)}
                        {f.readBy.length > 0 && <span className="chip small">read by {f.readBy.map((p) => PROVIDER_LABELS[p]).join(", ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt>Skills the agents can list</dt>
              <dd>
                {sources.skills.length === 0 ? (
                  <span className="muted small">none under .agents/skills (project) or ~/.agents/skills (user)</span>
                ) : (
                  <ul className="call-list">
                    {sources.skills.map((s) => (
                      <li className="small" key={s.path}>
                        <strong>{s.name ?? s.directoryName}</strong> <span className="chip small">{s.scope}</span>
                        {s.shadowed && <span className="chip small chip-warn">shadowed by a project skill</span>}
                        {s.problems.length > 0 && <span className="chip small chip-warn">{s.problems.length} problem(s)</span>} {s.description}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="small muted">An agent loads a skill when the task calls for it; that appears in the transcript.</span>
              </dd>
            </dl>
            {sources.notes.map((note) => (
              <p className="small muted" key={note}>
                {note}
              </p>
            ))}
            <button className="link" onClick={() => setView({ kind: "integrations" })} type="button">
              Open integration configuration
            </button>
          </>
        )}
      </section>

      <section>
        <h3>Context bundles</h3>
        <p className="small muted">
          A bundle is an explicit set of file references plus your own instructions, stored locally. Applying one adds its references as
          mentions and its text to the composer; nothing is written to AGENTS.md.
        </p>
        <div className="row wrap">
          <input className="input" onChange={(e) => setName(e.target.value)} placeholder="Bundle name" value={name} />
          <button className="button" disabled={!name.trim() || (mentions.length === 0 && !draft.trim())} onClick={saveCurrentAsBundle} type="button">
            Save current mentions and draft as bundle
          </button>
        </div>
        {(bundles ?? []).length === 0 ? (
          <p className="small muted">No bundles for this workspace.</p>
        ) : (
          <ul className="call-list">
            {(bundles ?? []).map((bundle) => (
              <li className="card" key={bundle.id}>
                <div className="row wrap">
                  <strong>{bundle.name}</strong>
                  <span className="small muted">
                    {bundle.refs.length} reference(s){bundle.instructions ? ", with instructions" : ""}
                  </span>
                  <button className="button button-small" onClick={() => applyBundle(sessionId, bundle)} type="button">
                    Apply to composer
                  </button>
                  <button className="button button-small" onClick={() => void deleteBundle(session.workspaceId, bundle.id)} type="button">
                    Delete
                  </button>
                </div>
                <div className="row wrap">
                  {bundle.refs.map((ref, index) => (
                    <span className="chip small mono" key={index}>
                      {ref.relativePath}
                      {ref.mode.mode === "copied_content" ? ` (copied${ref.mode.startLine ? ` ${ref.mode.startLine}-${ref.mode.endLine ?? ""}` : ""})` : " (path)"}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
