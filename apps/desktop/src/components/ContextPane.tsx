/**
 * Context and usage (CTX-01..04).
 *
 * Configured sources come from disk (instruction files, skills) and are
 * labelled as configured. Agent-reported facts (context used/size, token
 * counters, the account's quota) come from the agent's own updates and are
 * labelled as reported. The two are never merged into a
 * claim about what is "in context" right now.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ContextBundle, ContextSources, Mention, TranscriptUsage } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { t } from "../i18n";
import { api } from "../ipc";
import { useStore, windowDelta as windowDeltaOf } from "../store";
import { cacheEfficiency, percent } from "../usage";
import { UsageLine, signed, windowName } from "./UsageLine";

const EMPTY_LIST: never[] = [];

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function unknown(value: number | null | undefined): string {
  return value === null || value === undefined ? t("unknown") : value.toLocaleString();
}

/** A sentence with one piece of markup in it, at `{name}`. */
function around(text: string, name: string, node: ReactNode) {
  const [before, after] = text.split(`{${name}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
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
    return h >= 48 ? t("resets in {n} d", { n: Math.round(h / 24) }) : h > 0 ? t("resets in {h} h {m} min", { h, m }) : t("resets in {m} min", { m });
  };
  const su = session.usage;
  const primaryName = windowName(account?.primary?.windowSeconds);
  const secondaryName = windowName(account?.secondary?.windowSeconds);

  return (
    <div className="context-pane">
      <section>
        <h3>{t("{provider} subscription usage", { provider: PROVIDER_LABELS[provider] })}</h3>
        {!account && !quota && (
          <p className="small muted">
            {t("Nothing reported yet. {provider} reports its account’s quota as the session works; it appears here after the first turn.", { provider: PROVIDER_LABELS[provider] })}
          </p>
        )}
        {!account && quota && quota.status !== "rejected" && (
          <p className="small muted">
            {(() => {
              const where = quota.windows[0] ? t(" on its {kind} window", { kind: quota.windows[0].kind.replace(/_/g, " ") }) : "";
              return quota.status === "warning"
                ? t("The account reports that it is close to a limit{window}, without a percentage.", { window: where })
                : t("The account reports room{window}, without a percentage.", { window: where });
            })()}
          </p>
        )}
        {account && (
          <div className="row wrap">
            {account.primary && (
              <span className={`chip ${account.primary.usedPercent >= 90 ? "chip-warn" : ""}`} title={resetIn(resetAfter(account.primary.resetAtUnix))}>
                {t("{name} window: {left}% left ({used}% used) · {reset}", {
                  name: primaryName,
                  left: Math.max(0, 100 - Math.round(account.primary.usedPercent)),
                  used: Math.round(account.primary.usedPercent),
                  reset: resetIn(resetAfter(account.primary.resetAtUnix)),
                })}
              </span>
            )}
            {account.secondary && (
              <span className={`chip ${account.secondary.usedPercent >= 90 ? "chip-warn" : ""}`} title={resetIn(resetAfter(account.secondary.resetAtUnix))}>
                {t("{name} window: {left}% left ({used}% used) · {reset}", {
                  name: secondaryName,
                  left: Math.max(0, 100 - Math.round(account.secondary.usedPercent)),
                  used: Math.round(account.secondary.usedPercent),
                  reset: resetIn(resetAfter(account.secondary.resetAtUnix)),
                })}
              </span>
            )}
            {account.planType && <span className="chip">{account.planType}</span>}
            {account.limitReached && <span className="chip chip-warn">{t("limit reached")}</span>}
          </div>
        )}
        {account && (
          <>
            <div className="row wrap">
              <span className="chip chip-active">
                {t("this session used: {primary} {primaryDelta} · {secondary} {secondaryDelta} · {turns}", {
                  primary: primaryName,
                  primaryDelta: signed(su.totalPrimary),
                  secondary: secondaryName,
                  secondaryDelta: signed(su.totalSecondary),
                  turns: su.turns === 1 ? t("{n} turn", { n: su.turns }) : t("{n} turns", { n: su.turns }),
                })}
              </span>
              {su.resets > 0 && <span className="chip chip-warn">{t("{n} window reset(s) excluded", { n: su.resets })}</span>}
            </div>
            {su.lastTurn && <UsageLine label={t("Last turn")} primary={su.lastTurn.primary} primaryName={primaryName} secondary={su.lastTurn.secondary} secondaryName={secondaryName} />}
            {su.turnStart && su.latest && (
              <UsageLine label={t("Current turn so far")} primary={windowDeltaOf(su.turnStart.primary, su.latest.primary)} primaryName={primaryName} secondary={windowDeltaOf(su.turnStart.secondary, su.latest.secondary)} secondaryName={secondaryName} sampling={su.sampling} />
            )}
            {su.error && <p className="small chip-warn">{t("Last sample failed: {error}", { error: su.error })}</p>}
          </>
        )}
        <p className="small muted">
          {t("As {provider} reports it, account-wide: everything else using the subscription during a turn (other sessions, the provider’s own apps) lands in the same numbers. Session totals sum the per-turn differences since the session was attached in this app run; a window that resets mid-turn is excluded rather than guessed.", { provider: PROVIDER_LABELS[provider] })}
        </p>
      </section>

      <section>
        <h3>{t("Reported by the agent")}</h3>
        <div className="row wrap">
          <span className="chip">{t("context used: {used} / window: {size}", { used: unknown(projection.usage?.used), size: unknown(projection.usage?.size) })}</span>
          {projection.tokens && (
            <span className="chip">
              {t("wire counters: in {input} · out {output} · total {total}", { input: unknown(projection.tokens.input), output: unknown(projection.tokens.output), total: unknown(projection.tokens.total) })}
            </span>
          )}
          {model && <span className="chip">{t("model (live option): {model}", { model })}</span>}
        </div>
        <p className="small muted">
          {t("The agent reports the context used and the window size as it works; per-call token counts are not on the wire. The figures below are read from the agent's own transcript on disk.")}
        </p>
        <h4>{t("Token usage from the agent’s transcript")}</h4>
        {usageError && <p className="small chip-warn">{usageError}</p>}
        {usage && (
          <>
            <div className="row wrap">
              <span className="chip" title={t("Model responses. A response written several times is folded back into one.")}>
                {t("model responses: {n}", { n: usage.totals.calls })}
                {usage.totals.foldedItems > 0 ? ` ${t("({n} transcript items)", { n: usage.totals.calls + usage.totals.foldedItems })}` : ""}
              </span>
              <span className="chip">{t("input: {n}", { n: usage.totals.inputTokens.toLocaleString() })}</span>
              <span className="chip">{t("output: {n}", { n: usage.totals.outputTokens.toLocaleString() })}</span>
              <span className="chip">{t("total: {n}", { n: (usage.totals.inputTokens + usage.totals.outputTokens).toLocaleString() })}</span>
              <span className="chip">{t("reasoning: {n}", { n: `${usage.totals.reasoningTokens.toLocaleString()}${usage.totals.partial ? "+" : ""}` })}</span>
              <span className="chip">{t("cached input (subset of input): {n}", { n: `${usage.totals.cachedInputTokens.toLocaleString()}${usage.totals.partial ? "+" : ""}` })}</span>
              {usage.totals.cacheWriteInputTokens > 0 && <span className="chip">{t("cache write: {n}", { n: usage.totals.cacheWriteInputTokens.toLocaleString() })}</span>}
              <span className="chip">{usage.calls.some((c) => c.cost !== undefined) ? t("cost: reported by the agent") : t("cost: not reported")}</span>
            </div>
            <div className="row wrap">
              {(() => {
                const cache = cacheEfficiency(usage.totals);
                if (!cache)
                  return (
                    <span className="chip muted" title={t("A prefix has to be re-sent at least once before there is anything a cache could have served.")}>
                      {t("prompt cache: not measurable yet")}
                    </span>
                  );
                return (
                  <>
                    <span
                      className={cache.missedShare > 0.2 ? "chip chip-warn" : "chip"}
                      title={t("Prefix this session sent more than once, and how much of it the provider did not serve from its prompt cache. runtime/patches/0001 does.")}
                    >
                      {t("re-sent prefix missed by cache: {missed} / {cacheable} ({share})", {
                        missed: cache.missedPrefixTokens.toLocaleString(),
                        cacheable: cache.cacheablePrefixTokens.toLocaleString(),
                        share: percent(cache.missedShare),
                      })}
                      {cache.estimate ? ` ${t("(estimate)")}` : ""}
                    </span>
                    <span className="chip" title={t("Input tokens the provider did not serve from cache: the part billed at full rate.")}>
                      {t("paid input: {n}", { n: cache.paidInputTokens.toLocaleString() })}
                      {cache.missedShareOfPaid === null ? "" : ` ${t("({share} of it a cache miss)", { share: percent(cache.missedShareOfPaid) })}`}
                    </span>
                  </>
                );
              })()}
            </div>
            <p className="small muted">
              {around(
                t("Read from {path} ({lines} lines{errors}, schema {schema}).", {
                  lines: usage.lines,
                  errors: usage.parseErrors > 0 ? t(", {n} unparsable", { n: usage.parseErrors }) : "",
                  schema: usage.schemaVersions.join("/") || "?",
                }),
                "path",
                <span className="mono">{usage.path}</span>,
              )}{" "}
              {t("Input includes cached input; reasoning tokens are counted inside output by the provider. Refreshes when a turn settles.")}
            </p>
            <button className="link small" onClick={() => setShowCalls(!showCalls)} type="button">
              {showCalls ? t("hide per-call breakdown") : t("show per-call breakdown")}
            </button>
            {showCalls && (
              <table className="config-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("Item")}</th>
                    <th>{t("Input")}</th>
                    <th>{t("Cached")}</th>
                    <th>{t("Output")}</th>
                    <th>{t("Reasoning")}</th>
                    <th>{t("Missed prefix")}</th>
                    <th>{t("Context window")}</th>
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
                      <td>{c.cachedInputTokens?.toLocaleString() ?? t("unknown")}</td>
                      <td>{c.outputTokens.toLocaleString()}</td>
                      <td>{c.reasoningTokens?.toLocaleString() ?? t("unknown")}</td>
                      <td title={c.missedPrefixTokens === undefined ? t("No earlier prefix to reuse, or no cached figure reported.") : undefined}>
                        {c.missedPrefixTokens?.toLocaleString() ?? "—"}
                      </td>
                      <td>{c.contextWindow?.toLocaleString() ?? t("unknown")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {!usage && !usageError && <p className="small muted">{t("Reading the agent’s transcript…")}</p>}
      </section>

      <section>
        <h3>{t("Configured on disk")}</h3>
        {!sources ? (
          <p className="muted">{t("Reading configuration…")}</p>
        ) : (
          <>
            <dl className="facts">
              <dt>{t("Effective root")}</dt>
              <dd className="mono">{sources.root}</dd>
              <dt>{t("Instruction files (AGENTS.md and CLAUDE.md, nearest first)")}</dt>
              <dd>
                {sources.instructionFiles.length === 0 ? (
                  <span className="muted small">{t("none found at the root or its ancestors")}</span>
                ) : (
                  <ul className="call-list">
                    {sources.instructionFiles.map((f) => (
                      <li className="small" key={f.path}>
                        <span className="mono">{f.path}</span> · {bytes(f.bytes)} · blake3 {f.contentHash.slice(0, 12)}
                        {f.readBy.length > 0 && <span className="chip small">{t("read by {providers}", { providers: f.readBy.map((p) => PROVIDER_LABELS[p]).join(", ") })}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt>{t("Skills the agents can list")}</dt>
              <dd>
                {sources.skills.length === 0 ? (
                  <span className="muted small">{t("none under .agents/skills (project) or ~/.agents/skills (user)")}</span>
                ) : (
                  <ul className="call-list">
                    {sources.skills.map((s) => (
                      <li className="small" key={s.path}>
                        <strong>{s.name ?? s.directoryName}</strong> <span className="chip small">{s.scope}</span>
                        {s.shadowed && <span className="chip small chip-warn">{t("shadowed by a project skill")}</span>}
                        {s.problems.length > 0 && <span className="chip small chip-warn">{t("{n} problem(s)", { n: s.problems.length })}</span>} {s.description}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="small muted">{t("An agent loads a skill when the task calls for it; that appears in the transcript.")}</span>
              </dd>
            </dl>
            {sources.notes.map((note) => (
              <p className="small muted" key={note}>
                {note}
              </p>
            ))}
            <button className="link" onClick={() => setView({ kind: "integrations" })} type="button">
              {t("Open integration configuration")}
            </button>
          </>
        )}
      </section>

      <section>
        <h3>{t("Context bundles")}</h3>
        <p className="small muted">
          {t("A bundle is an explicit set of file references plus your own instructions, stored locally. Applying one adds its references as mentions and its text to the composer; nothing is written to AGENTS.md.")}
        </p>
        <div className="row wrap">
          <input className="input" onChange={(e) => setName(e.target.value)} placeholder={t("Bundle name")} value={name} />
          <button className="button" disabled={!name.trim() || (mentions.length === 0 && !draft.trim())} onClick={saveCurrentAsBundle} type="button">
            {t("Save current mentions and draft as bundle")}
          </button>
        </div>
        {(bundles ?? []).length === 0 ? (
          <p className="small muted">{t("No bundles for this workspace.")}</p>
        ) : (
          <ul className="call-list">
            {(bundles ?? []).map((bundle) => (
              <li className="card" key={bundle.id}>
                <div className="row wrap">
                  <strong>{bundle.name}</strong>
                  <span className="small muted">
                    {bundle.instructions ? t("{n} reference(s), with instructions", { n: bundle.refs.length }) : t("{n} reference(s)", { n: bundle.refs.length })}
                  </span>
                  <button className="button button-small" onClick={() => applyBundle(sessionId, bundle)} type="button">
                    {t("Apply to composer")}
                  </button>
                  <button className="button button-small" onClick={() => void deleteBundle(session.workspaceId, bundle.id)} type="button">
                    {t("Delete")}
                  </button>
                </div>
                <div className="row wrap">
                  {bundle.refs.map((ref, index) => (
                    <span className="chip small mono" key={index}>
                      {ref.relativePath}
                      {ref.mode.mode === "copied_content" ? ` (${t("copied")}${ref.mode.startLine ? ` ${ref.mode.startLine}-${ref.mode.endLine ?? ""}` : ""})` : ` (${t("path")})`}
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
