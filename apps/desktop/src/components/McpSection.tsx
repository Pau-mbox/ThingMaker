/**
 * MCP servers in the Integrations panel: a short catalog to install from in
 * one click, a box to paste any config or command into, a test start before
 * anything is written, and what each provider already has.
 *
 * Installing runs each provider's own `mcp add`, so the server lands where
 * that provider reads it — in ThingMaker's sessions and in the provider's own
 * app alike — and applies to sessions started afterwards.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PROVIDER_LABELS, type InstalledMcpServer, type McpCatalogEntry, type McpInstallOutcome, type McpOverview, type McpProbe, type McpScope, type McpServerSpec, type Provider } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { ProviderBadge } from "./ProviderMark";

const PROVIDER_NAME: Record<Provider, string> = { ...PROVIDER_LABELS, gemini: "Antigravity (Gemini)" };

/** A server as editable text: the command line or the URL, and its pairs. */
type Draft = { name: string; kind: "stdio" | "http"; target: string; pairs: { key: string; value: string }[] };

function quote(word: string): string {
  return /[\s"']/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word;
}

function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoteChar: string | null = null;
  let any = false;
  for (const c of text) {
    if (quoteChar) {
      if (c === quoteChar) quoteChar = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quoteChar = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (current || any) words.push(current);
      current = "";
      any = false;
    } else current += c;
  }
  if (current || any) words.push(current);
  return words;
}

function toDraft(spec: McpServerSpec): Draft {
  if (spec.transport.type === "http") {
    return { name: spec.name, kind: "http", target: spec.transport.url, pairs: Object.entries(spec.transport.headers).map(([key, value]) => ({ key, value })) };
  }
  return {
    name: spec.name,
    kind: "stdio",
    target: [spec.transport.command, ...spec.transport.args].map(quote).join(" "),
    pairs: Object.entries(spec.transport.env).map(([key, value]) => ({ key, value })),
  };
}

function fromDraft(draft: Draft): McpServerSpec {
  const pairs = Object.fromEntries(draft.pairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]));
  if (draft.kind === "http") return { name: draft.name.trim(), transport: { type: "http", url: draft.target.trim(), headers: pairs } };
  const [command = "", ...args] = splitWords(draft.target.trim());
  return { name: draft.name.trim(), transport: { type: "stdio", command, args, env: pairs } };
}

/** `${NAME}` references in a draft's values. */
function referencesOf(draft: Draft): string[] {
  const names = new Set<string>();
  for (const text of [draft.target, ...draft.pairs.map((pair) => pair.value)]) for (const match of text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) names.add(match[1] as string);
  return [...names];
}

function InstallCard({
  initial,
  overview,
  workspaceId,
  runtimeNames,
  needs,
  onDone,
  onCancel,
}: {
  initial: McpServerSpec;
  overview: McpOverview;
  workspaceId: string | null;
  runtimeNames: string[];
  needs?: string | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const setError = useStore((s) => s.setError);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const available = overview.providers.filter((entry) => entry.available).map((entry) => entry.provider);
  const [providers, setProviders] = useState<Provider[]>(() => available.filter((provider) => provider !== "gemini"));
  const [scope, setScope] = useState<McpScope>("user");
  const [probe, setProbe] = useState<{ busy: boolean; result?: McpProbe; error?: string }>({ busy: false });
  const [installing, setInstalling] = useState(false);
  const [outcomes, setOutcomes] = useState<McpInstallOutcome[] | null>(null);

  const references = referencesOf(draft);
  const missing = references.filter((name) => !runtimeNames.includes(name));
  const codexUnsupported = draft.kind === "http" && draft.pairs.some((pair) => pair.key.trim() && !(pair.key.trim().toLowerCase() === "authorization" && /^Bearer \$\{[A-Za-z0-9_]+\}$/.test(pair.value.trim())));
  const nameOk = /^[A-Za-z0-9_-]{1,64}$/.test(draft.name.trim());
  const exists = overview.servers.some((server) => server.name === draft.name.trim());

  const patch = (change: Partial<Draft>) => {
    setDraft({ ...draft, ...change });
    setProbe({ busy: false });
  };

  const test = async () => {
    setProbe({ busy: true });
    try {
      setProbe({ busy: false, result: await api.mcpTest(workspaceId, fromDraft(draft)) });
    } catch (error) {
      setProbe({ busy: false, error: (error as { message?: string }).message ?? String(error) });
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      const results = await api.mcpInstall(workspaceId, fromDraft(draft), providers, scope);
      setOutcomes(results);
      if (results.every((result) => result.ok)) onDone();
    } catch (error) {
      setError(error);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="card mcp-install">
      <div className="row wrap">
        <label className="mcp-field">
          <span className="small">Name</span>
          <input aria-label="Server name" className="input mono" onChange={(event) => patch({ name: event.target.value })} value={draft.name} />
        </label>
        <label className="mcp-field">
          <span className="small">Runs as</span>
          <select aria-label="Runs as" className="select" onChange={(event) => patch({ kind: event.target.value as Draft["kind"] })} value={draft.kind}>
            <option value="stdio">a program (stdio)</option>
            <option value="http">a URL (HTTP)</option>
          </select>
        </label>
      </div>
      {!nameOk && <p className="small chip-warn">Letters, digits, - and _ only.</p>}
      {exists && <p className="small muted">A server with this name exists already; installing replaces it for the providers you choose.</p>}
      <label className="mcp-field">
        <span className="small">{draft.kind === "http" ? "URL" : "Command"}</span>
        <input aria-label={draft.kind === "http" ? "Server URL" : "Server command"} className="input mono" onChange={(event) => patch({ target: event.target.value })} value={draft.target} />
      </label>
      <div className="mcp-pairs">
        <span className="small">{draft.kind === "http" ? "Headers" : "Environment"}</span>
        {draft.pairs.map((pair, index) => (
          <div className="row" key={index}>
            <input aria-label="Key" className="input mono" onChange={(event) => patch({ pairs: draft.pairs.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry)) })} placeholder={draft.kind === "http" ? "Authorization" : "API_KEY"} value={pair.key} />
            <input aria-label="Value" className="input mono" onChange={(event) => patch({ pairs: draft.pairs.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)) })} placeholder={draft.kind === "http" ? "Bearer ${TOKEN}" : "${API_KEY}"} value={pair.value} />
            <button aria-label="Remove" className="button button-small" onClick={() => patch({ pairs: draft.pairs.filter((_, at) => at !== index) })} type="button">
              ×
            </button>
          </div>
        ))}
        <button className="link small" onClick={() => patch({ pairs: [...draft.pairs, { key: "", value: "" }] })} type="button">
          + add {draft.kind === "http" ? "a header" : "a variable"}
        </button>
        <span className="small muted">
          Keep secrets out of config files: store them under <strong>Runtime environment</strong> below and write <span className="mono">{"${NAME}"}</span> here. Claude Code reads the
          reference itself; for Codex the variable is forwarded from the session.
        </span>
        {missing.length > 0 && <span className="small chip-warn">Not in the runtime environment yet: {missing.join(", ")}.</span>}
      </div>

      <div className="mcp-targets">
        <span className="small">Install for</span>
        {overview.providers.map(({ provider, available: ok, problem }) => {
          const blocked = !ok || (provider === "codex" && codexUnsupported);
          return (
            <label className="odyssey-toggle" key={provider} title={problem ?? undefined}>
              <input
                checked={providers.includes(provider) && !blocked}
                disabled={blocked}
                onChange={(event) => setProviders(event.target.checked ? [...providers, provider] : providers.filter((entry) => entry !== provider))}
                type="checkbox"
              />
              <ProviderBadge provider={provider} />
              <span className="small">
                {PROVIDER_NAME[provider]}
                {!ok && <span className="muted"> — not installed</span>}
                {ok && provider === "codex" && codexUnsupported && <span className="muted"> — takes HTTP credentials only as Authorization: Bearer ${"{VARIABLE}"}</span>}
                {ok && provider === "gemini" && <span className="muted"> — Antigravity reads values as written</span>}
              </span>
            </label>
          );
        })}
        {providers.includes("claude") && workspaceId && (
          <label className="mcp-field">
            <span className="small">Claude Code scope</span>
            <select aria-label="Claude Code scope" className="select" onChange={(event) => setScope(event.target.value as McpScope)} value={scope}>
              <option value="user">Every project</option>
              <option value="local">This project only</option>
            </select>
          </label>
        )}
      </div>

      {needs && <p className="small muted">Starts with {needs === "uv" ? "uvx, from uv (astral.sh/uv)" : "npx, from Node.js"}; the first start downloads the package.</p>}

      {probe.busy && <p className="small muted">Starting it the way a session would…</p>}
      {probe.result && (
        <p className="small">
          <span className="chip small chip-active">works</span> {probe.result.server ?? draft.name}
          {probe.result.version ? ` ${probe.result.version}` : ""} — {probe.result.tools.length} tool{probe.result.tools.length === 1 ? "" : "s"}
          {probe.result.tools.length > 0 && <span className="muted">: {probe.result.tools.slice(0, 12).join(", ")}{probe.result.tools.length > 12 ? ", …" : ""}</span>}
        </p>
      )}
      {probe.error && <pre className="small chip-warn mcp-error">{probe.error}</pre>}
      {outcomes && (
        <ul className="call-list">
          {outcomes.map((outcome) => (
            <li className={`small ${outcome.ok ? "" : "chip-warn"}`} key={outcome.provider}>
              {PROVIDER_NAME[outcome.provider]}: {outcome.message}
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap">
        <button className="button button-primary" disabled={!nameOk || !draft.target.trim() || providers.length === 0 || installing} onClick={() => void install()} type="button">
          {installing ? "Installing…" : `Install for ${providers.length} provider${providers.length === 1 ? "" : "s"}`}
        </button>
        <button className="button" disabled={!draft.target.trim() || probe.busy} onClick={() => void test()} type="button">
          Test it
        </button>
        <button className="button" onClick={onCancel} type="button">
          Cancel
        </button>
        <span className="small muted">Applies to sessions started afterwards.</span>
      </div>
    </div>
  );
}

export function McpSection({ workspaceId }: { workspaceId: string | null }) {
  const setError = useStore((s) => s.setError);
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [runtimeNames, setRuntimeNames] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [pending, setPending] = useState<{ spec: McpServerSpec; needs?: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, env] = await Promise.all([api.mcpOverview(workspaceId), api.runtimeEnvList().catch(() => null)]);
      setOverview(loaded);
      setRuntimeNames(env?.names ?? []);
    } catch (error) {
      setError(error);
    }
  }, [workspaceId, setError]);

  useEffect(() => {
    void load();
    void api
      .mcpCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, [load]);

  const grouped = useMemo(() => {
    const byName = new Map<string, InstalledMcpServer[]>();
    for (const server of overview?.servers ?? []) byName.set(server.name, [...(byName.get(server.name) ?? []), server]);
    return [...byName.entries()];
  }, [overview]);

  const fromCatalog = (entry: McpCatalogEntry) => {
    const spec: McpServerSpec =
      entry.spec.transport.type === "stdio"
        ? { ...entry.spec, transport: { ...entry.spec.transport, args: entry.spec.transport.args.map((arg) => arg.replace("{folder}", overview?.folder ?? ".")) } }
        : entry.spec;
    setPending([{ spec, ...(entry.needs ? { needs: entry.needs } : {}) }]);
  };

  const read = async () => {
    try {
      const specs = await api.mcpParse(paste);
      setPending(specs.map((spec) => ({ spec })));
      setPaste("");
    } catch (error) {
      setError(error);
    }
  };

  const remove = async (server: InstalledMcpServer) => {
    const confirmed = await api.confirmDialog({
      title: `Remove ${server.name} from ${PROVIDER_NAME[server.provider]}?`,
      message: `${PROVIDER_NAME[server.provider]}'s own mcp remove takes it out of ${server.source}. Sessions started afterwards no longer have it.`,
      okLabel: "Remove",
      cancelLabel: "Keep it",
      warning: true,
    });
    if (!confirmed) return;
    try {
      await api.mcpRemove(workspaceId, server.provider, server.name, server.scope);
      setNote(`Removed ${server.name} from ${PROVIDER_NAME[server.provider]}.`);
      await load();
    } catch (error) {
      setError(error);
    }
  };

  const installedNames = new Set(overview?.servers.map((server) => server.name));

  return (
    <section className="mcp-section">
      <h3>MCP servers</h3>
      <p className="small muted">
        Tools agents can call: a browser, your issue tracker, a design file. Installing writes the server through each provider&rsquo;s own <span className="mono">mcp add</span>, so it
        works in ThingMaker&rsquo;s sessions and in the provider&rsquo;s own app, from the next session on.
      </p>

      {pending.length > 0 && overview ? (
        <div className="mcp-pending">
          {pending.map((entry, index) => (
            <InstallCard
              initial={entry.spec}
              key={`${entry.spec.name}-${index}`}
              needs={entry.needs}
              onCancel={() => setPending(pending.filter((_, at) => at !== index))}
              onDone={() => {
                setNote(`Installed ${entry.spec.name}. New sessions have it.`);
                setPending(pending.filter((_, at) => at !== index));
                void load();
              }}
              overview={overview}
              runtimeNames={runtimeNames}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="mcp-catalog">
            {catalog.map((entry) => (
              <div className="card mcp-catalog-entry" key={entry.id}>
                <div className="row wrap">
                  <strong>{entry.title}</strong>
                  {installedNames.has(entry.spec.name) && <span className="chip small chip-active">installed</span>}
                </div>
                <p className="small muted">{entry.description}</p>
                {entry.secrets.length > 0 && <p className="small muted">Needs {entry.secrets.map(([name, where]) => `${name} (${where})`).join(", ")}.</p>}
                <div className="row wrap">
                  <button className="button button-small" onClick={() => fromCatalog(entry)} type="button">
                    {installedNames.has(entry.spec.name) ? "Reinstall…" : "Install…"}
                  </button>
                  <button className="link small" onClick={() => void api.openExternal(entry.homepage)} type="button">
                    about
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mcp-paste">
            <textarea
              aria-label="Paste an MCP config or command"
              className="textarea mono"
              onChange={(event) => setPaste(event.target.value)}
              placeholder={'Paste a server from its README: {"mcpServers": {…}}, "claude mcp add …", "codex mcp add …" or just "npx -y some-mcp-server"'}
              rows={3}
              value={paste}
            />
            <button className="button" disabled={!paste.trim()} onClick={() => void read()} type="button">
              Read it
            </button>
          </div>
        </>
      )}

      {note && (
        <p className="small">
          {note}{" "}
          <button className="link small" onClick={() => setNote(null)} type="button">
            dismiss
          </button>
        </p>
      )}

      <h4 className="small">Installed</h4>
      {grouped.length === 0 ? (
        <p className="small muted">No MCP servers configured for any provider yet.</p>
      ) : (
        <ul className="call-list">
          {grouped.map(([name, servers]) => (
            <li className="card mcp-installed" key={name}>
              <div className="row wrap">
                <strong className="mono">{name}</strong>
                <span className="small muted mono mcp-summary">{servers[0]?.summary}</span>
              </div>
              {servers.map((server) => (
                <div className="row wrap mcp-installed-row" key={`${server.provider}-${server.scope}`}>
                  <ProviderBadge provider={server.provider} />
                  <span className="small">{PROVIDER_NAME[server.provider]}</span>
                  <span className="chip small">{server.scope === "user" ? "every project" : server.scope === "local" ? "this project" : "shared .mcp.json"}</span>
                  {!server.enabled && <span className="chip small chip-warn">disabled</span>}
                  {[...server.envKeys, ...server.headerKeys].length > 0 && <span className="small muted">uses {[...server.envKeys, ...server.headerKeys].join(", ")}</span>}
                  <span className="composer-spacer" />
                  {server.scope !== "project" && (
                    <button className="link small" onClick={() => void remove(server)} type="button">
                      remove
                    </button>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
