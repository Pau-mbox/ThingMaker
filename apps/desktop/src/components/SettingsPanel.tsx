import { useEffect, useState } from "react";
import {
  CLAUDE_ORCHESTRATOR_EFFORT,
  CLAUDE_ORCHESTRATOR_MODEL,
  type CleanupCandidate,
  type ClaudeModelChoice,
  type NotificationSettings,
  type StorageReport,
} from "@thingmaker/contracts";
import { useStore, basenameOf } from "../store";
import { api } from "../ipc";
import { redactText } from "../redact";

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function SupportBundleSection() {
  const setError = useStore((s) => s.setError);
  const [preview, setPreview] = useState<{ text: string; redactions: number } | null>(null);
  const generate = async () => {
    try {
      const bundle = await api.supportBundlePreview();
      const { text, redactions } = redactText(JSON.stringify(bundle, null, 2));
      setPreview({ text, redactions: redactions.reduce((n, r) => n + r.count, 0) });
    } catch (error) {
      setError(error);
    }
  };
  const save = async () => {
    if (!preview) return;
    try {
      await api.saveTextFile(`thingmaker-support-${new Date().toISOString().slice(0, 10)}.json`, preview.text);
    } catch (error) {
      setError(error);
    }
  };
  return (
    <section>
      <h3>Support bundle</h3>
      <p className="small muted">
        Generated locally: app, runtime and schema versions, OS family, anonymized live-session state, uncertain-submission count, recent warning and error log
        lines (home directory collapsed) and notification settings. Excluded: prompts, transcripts, environment variables, tokens. Nothing is uploaded; you review
        the redacted text and save it yourself.
      </p>
      <div className="row wrap">
        <button className="button" onClick={() => void generate()} type="button">
          Generate preview
        </button>
        {preview && (
          <>
            <button className="button button-primary" onClick={() => void save()} type="button">
              Save…
            </button>
            <span className="small muted">{preview.redactions} secret-looking value(s) redacted</span>
          </>
        )}
      </div>
      {preview && <textarea className="textarea support-preview" readOnly value={preview.text} />}
    </section>
  );
}

function StorageSection() {
  const setError = useStore((s) => s.setError);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [candidates, setCandidates] = useState<CleanupCandidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const load = () => api.storageInspect().then(setReport).catch(setError);
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = async () => {
    try {
      const list = await api.cleanupPreview();
      setCandidates(list);
      setChecked(new Set(list.map((c) => c.path)));
    } catch (error) {
      setError(error);
    }
  };
  const run = async () => {
    try {
      await api.cleanupRun([...checked]);
      setCandidates(null);
      await load();
    } catch (error) {
      setError(error);
    }
  };
  return (
    <section>
      <h3>Storage and retention</h3>
      {!report ? (
        <p className="muted small">Inspecting…</p>
      ) : (
        <>
          <p className="small muted mono">{report.dataDir}</p>
          <table className="config-table">
            <thead>
              <tr>
                <th>Area</th>
                <th>Size</th>
                <th>Retention</th>
              </tr>
            </thead>
            <tbody>
              {report.entries.map((e) => (
                <tr key={e.name}>
                  <td title={e.path}>{e.name}</td>
                  <td>{bytes(e.bytes)}</td>
                  <td className="small muted">{e.policy}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            {report.attachments} attachment(s), {report.artifactVersions} artifact content hash(es). Defaults: seven days for desktop logs, thirty days for
            unreferenced caches, never for agent history or exported artifacts.
          </p>
          {report.notes.map((n) => (
            <p className="small muted" key={n}>
              {n}
            </p>
          ))}
          <div className="row wrap">
            <button className="button" onClick={() => void preview()} type="button">
              Preview cleanup
            </button>
            <button className="button" onClick={() => void load()} type="button">
              Refresh sizes
            </button>
          </div>
          {candidates && (
            <div className="card">
              {candidates.length === 0 ? (
                <p className="small muted">Nothing is past retention.</p>
              ) : (
                <>
                  <ul className="call-list">
                    {candidates.map((c) => (
                      <li className="small" key={c.path}>
                        <label className="check">
                          <input
                            checked={checked.has(c.path)}
                            onChange={() => {
                              const next = new Set(checked);
                              if (next.has(c.path)) next.delete(c.path);
                              else next.add(c.path);
                              setChecked(next);
                            }}
                            type="checkbox"
                          />{" "}
                          <span className="chip small">{c.kind.replace("_", " ")}</span> <span className="mono">{c.path}</span> · {bytes(c.bytes)} · {c.reason}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <button className="button button-warn" disabled={checked.size === 0} onClick={() => void run()} type="button">
                    Delete {checked.size} selected
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What the picker offers before the account's own catalog has answered, and
 * if it never does. Not a claim about what this account can select — the
 * catalog is the authority — just somewhere for the control to start.
 */
const BUILT_IN_CLAUDE_MODELS: ClaudeModelChoice[] = [
  { value: CLAUDE_ORCHESTRATOR_MODEL, name: "Fable 5.1", needsCredits: false },
  { value: "opus", name: "Opus 5.5", needsCredits: false },
  { value: "sonnet", name: "Sonnet 5.5", needsCredits: false },
  { value: "haiku", name: "Haiku 4.5", needsCredits: false },
];

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const saveSettings = useStore((s) => s.saveSettings);
  const testNotification = useStore((s) => s.testNotification);
  const workspaces = useStore((s) => s.workspaces);
  const uiPrefs = useStore((s) => s.uiPrefs);
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  const sessionDefaults = useStore((s) => s.sessionDefaults);
  const resetSessionDefaults = useStore((s) => s.resetSessionDefaults);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  // The account's own catalog, so the picker offers what this account can
  // actually select rather than a list compiled from memory. It is per
  // account and only populated once signed in, so a failure falls back to the
  // built-in choices rather than leaving an empty menu. Above the early
  // return below: hooks run in the same order on every render.
  const [claudeModels, setClaudeModels] = useState<ClaudeModelChoice[]>(BUILT_IN_CLAUDE_MODELS);
  const [claudeModelsProblem, setClaudeModelsProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .providerModels("claude")
      .then((models) => {
        if (cancelled || models.length === 0) return;
        setClaudeModels(
          models.map((model) => ({ value: model.id, name: model.name, needsCredits: model.needsCredits, ...(model.description ? { description: model.description } : {}) })),
        );
        setClaudeModelsProblem(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setClaudeModelsProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) {
    return (
      <div className="panel">
        <p className="muted">Loading settings…</p>
      </div>
    );
  }

  const update = (patch: Partial<NotificationSettings>) => void saveSettings({ ...settings, ...patch });

  const toggleMuted = (id: string) =>
    update({
      mutedWorkspaceIds: settings.mutedWorkspaceIds.includes(id)
        ? settings.mutedWorkspaceIds.filter((w) => w !== id)
        : [...settings.mutedWorkspaceIds, id],
    });

  return (
    <div className="panel">
      <h2>Settings</h2>

      <section>
        <h3>Composer and keyboard</h3>
        <label className="check">
          <input checked={uiPrefs.enterSends} onChange={(e) => void setUiPrefs({ enterSends: e.target.checked })} type="checkbox" /> Enter sends, Shift+Enter inserts a newline
          (unchecked inverts both)
        </label>
        <label className="check">
          Transcript page size{" "}
          <input
            className="input inline"
            max={500}
            min={10}
            onChange={(e) => void setUiPrefs({ transcriptPage: Math.max(10, Math.min(500, Number(e.target.value) || 50)) })}
            type="number"
            value={uiPrefs.transcriptPage}
          />{" "}
          <span className="small muted">entries rendered at once; earlier entries load on request</span>
        </label>
        <p className="small muted">
          Shortcuts: ⌘K command palette, ⌘O add workspace, ⌘N new session, ⌘1-9 switch sessions, ⌘L focus composer, ⌘F search transcript, ⌘I integrations, ⌘,
          sign-in, ⌘; settings.
        </p>
      </section>

      <section>
        <h3>Session defaults</h3>
        <p className="small muted">
          Changing the model or effort in a session makes that choice the default for sessions started afterwards (it is passed to the agent at launch; the agent's
          config.toml is not modified).
        </p>
        <div className="row wrap">
          <span className="chip small">model: {sessionDefaults.model ?? "the account's default"}</span>
          {sessionDefaults.provider && <span className="chip small">provider: {sessionDefaults.provider}</span>}
          <span className="chip small">effort: {sessionDefaults.reasoningEffort ?? "default"}</span>
          {(sessionDefaults.model || sessionDefaults.reasoningEffort) && (
            <button className="button button-small" onClick={() => void resetSessionDefaults()} type="button">
              Reset to the account's defaults
            </button>
          )}
        </div>
      </section>

      <section>
        <h3>Super Thing</h3>
        <p className="small muted">
          Defaults for a new goal (docs/plans/odyssey.md). A goal keeps whatever ceiling it was created with, so raising these never loosens a goal that is
          already running.
        </p>
        {/* The orchestrator's own model, which is not the same choice as the
            subagent floor in Integrations and must not share a control with
            it (docs/plans/odyssey.md §12.9). */}
        <label className="field">
          <span className="small">Model when Claude runs the goal</span>
          <select
            aria-label="Model when Claude runs the goal"
            className="select"
            onChange={(e) => update({ claudeOrchestratorModel: e.target.value })}
            value={settings?.claudeOrchestratorModel ?? CLAUDE_ORCHESTRATOR_MODEL}
          >
            {claudeModels.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.name}
                {choice.needsCredits ? " · uses credits" : ""}
              </option>
            ))}
          </select>
          <span className="small muted">
            For new Claude sessions and goals, unless a team preset or the session picks another. Fable is the default; a session that cannot select it
            (the adapter does not list it, or the account cannot use it) falls back to Opus — a working run on another model beats no run.
            {claudeModelsProblem ? ` The catalog could not be read (${claudeModelsProblem}), so this is the built-in list.` : ""}
          </span>
        </label>
        <label className="field">
          <span className="small">Effort when Claude runs the goal</span>
          <select
            aria-label="Effort when Claude runs the goal"
            className="select"
            onChange={(e) => update({ claudeOrchestratorEffort: e.target.value })}
            value={settings?.claudeOrchestratorEffort ?? CLAUDE_ORCHESTRATOR_EFFORT}
          >
            {["low", "medium", "high", "xhigh", "max"].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <span className="small muted">A long-horizon run is mostly planning and reading, which is what effort buys.</span>
        </label>
        <label className="field">
          <span className="small">Continuation limit for a new goal</span>
          <input
            className="input"
            inputMode="numeric"
            onChange={(e) => {
              const value = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(value) && value > 0) update({ odysseyMaxContinuations: value });
            }}
            value={settings?.odysseyMaxContinuations ?? 10}
          />
          <span className="small muted">Super Thing stops after this many continuations whatever state the goal is in. Keep it low until you have watched a full run.</span>
        </label>
        <label className="field">
          <span className="small">Token budget for a new goal</span>
          <input
            className="input"
            inputMode="numeric"
            onChange={(e) => {
              const trimmed = e.target.value.trim();
              if (!trimmed) {
                // Clearing the field means "no ceiling", which is the absent
                // field rather than a zero.
                if (settings) {
                  const { odysseyTokenBudget: _cleared, ...rest } = settings;
                  void saveSettings(rest);
                }
                return;
              }
              const value = Number.parseInt(trimmed, 10);
              if (Number.isFinite(value) && value > 0) update({ odysseyTokenBudget: value });
            }}
            placeholder="no budget"
            value={settings?.odysseyTokenBudget ?? ""}
          />
          <span className="small muted">Paid input and output, counted from the agent's own transcript. Blank means no ceiling; the spend is still recorded.</span>
        </label>
      </section>

      <section>
        <h3>Accessibility</h3>
        <label className="check">
          <input checked={uiPrefs.reducedMotion === "reduce"} onChange={(e) => void setUiPrefs({ reducedMotion: e.target.checked ? "reduce" : "system" })} type="checkbox" /> Reduce motion
          regardless of the system setting
        </label>
        <p className="small muted">
          The system reduced-motion and increased-contrast preferences are honoured automatically. Streamed tokens are not announced; screen readers hear settled
          turns, input requests and helper exits. All actions are reachable from the keyboard and the command palette.
        </p>
      </section>

      <section>
        <h3>Notifications</h3>
        <p className="small muted">
          Alerts distinguish finished, failed and needs-input sessions. Their text never includes prompt or code content. The operating
          system permission is requested the first time an alert is actually shown.
        </p>
        <label className="check">
          <input checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} type="checkbox" /> Enable notifications
        </label>
        <label className="check">
          <input checked={settings.notifyCompleted} disabled={!settings.enabled} onChange={(e) => update({ notifyCompleted: e.target.checked })} type="checkbox" /> Turn
          finished
        </label>
        <label className="check">
          <input checked={settings.notifyFailed} disabled={!settings.enabled} onChange={(e) => update({ notifyFailed: e.target.checked })} type="checkbox" /> Turn failed
          or helper exited
        </label>
        <label className="check">
          <input checked={settings.notifyNeedsInput} disabled={!settings.enabled} onChange={(e) => update({ notifyNeedsInput: e.target.checked })} type="checkbox" /> An agent
          asked for input
        </label>
        <div className="row wrap">
          <label className="small">
            Quiet hours from{" "}
            <input className="input inline" disabled={!settings.enabled} onChange={(e) => update({ quietHoursStart: e.target.value })} type="time" value={settings.quietHoursStart} />
          </label>
          <label className="small">
            to <input className="input inline" disabled={!settings.enabled} onChange={(e) => update({ quietHoursEnd: e.target.value })} type="time" value={settings.quietHoursEnd} />
          </label>
          <span className="small muted">(same start and end means no quiet hours)</span>
        </div>
        <button className="button" disabled={!settings.enabled} onClick={() => void testNotification()} type="button">
          Send test notification
        </button>
      </section>

      <section>
        <h3>Muted workspaces</h3>
        {workspaces.length === 0 && <p className="small muted">No workspaces yet.</p>}
        {workspaces.map((workspace) => (
          <label className="check" key={workspace.id}>
            <input checked={settings.mutedWorkspaceIds.includes(workspace.id)} onChange={() => toggleMuted(workspace.id)} type="checkbox" /> {basenameOf(workspace.displayPath)}{" "}
            <span className="small muted mono">{workspace.displayPath}</span>
          </label>
        ))}
      </section>

      <section>
        <h3>Closing the window</h3>
        <p className="small muted">
          Closing the last window never silently stops local work. Choose what happens: keep sessions running in the tray, quit and
          stop them, or ask every time.
        </p>
        {(["ask", "tray", "quit"] as const).map((behavior) => (
          <label className="check" key={behavior}>
            <input checked={settings.closeBehavior === behavior} name="closeBehavior" onChange={() => update({ closeBehavior: behavior })} type="radio" />{" "}
            {behavior === "ask" ? "Ask each time" : behavior === "tray" ? "Keep running in the tray" : "Quit and stop local tasks"}
          </label>
        ))}
      </section>

      <SupportBundleSection />
      <StorageSection />
    </div>
  );
}
