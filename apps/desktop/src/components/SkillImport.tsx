/**
 * Import skills from a folder or a .zip (CFG-10). The source is staged and
 * validated natively; the user reviews what was found (names, files,
 * frontmatter problems, collisions) and chooses the scope before anything is
 * written into a skills root. Existing skills are only replaced on request
 * and are kept as a backup directory.
 */
import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ImportPlan, SkillScope } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { t } from "../i18n";

/** A skill scope as the person reads it. */
const scopeLabel = (scope: SkillScope) => (scope === "project" ? t("project") : t("user"));

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function SkillImport({ workspaceId, onDone }: { workspaceId: string | null; onDone: () => void }) {
  const setError = useStore((s) => s.setError);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [scope, setScope] = useState<SkillScope>(workspaceId ? "project" : "user");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const stage = async (kind: "folder" | "zip" | "paths", paths?: string[]) => {
    setBusy(true);
    try {
      const staged =
        kind === "paths" ? (paths ? await api.skillImportFromPaths(paths, scope, workspaceId) : null) : await api.skillImportPick(kind, scope, workspaceId);
      if (staged) {
        setPlan(staged);
        setSelected(new Set(staged.skills.filter((s) => s.problems.every((p) => !p.startsWith("missing"))).map((s) => s.directoryName)));
        setReplace(false);
        setResult(null);
      }
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  // Re-annotate collisions when the scope changes.
  useEffect(() => {
    if (!plan) return;
    api
      .skillImportAnnotate(plan.stagingId, scope, workspaceId)
      .then(setPlan)
      .catch(setError);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // OS drag-and-drop of a folder or zip onto the Integrations view.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    webview
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setDropping(true);
        else if (event.payload.type === "leave") setDropping(false);
        else if (event.payload.type === "drop") {
          setDropping(false);
          if (useStore.getState().view.kind !== "integrations") return;
          void stage("paths", event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [scope, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const discard = async () => {
    if (plan) {
      try {
        await api.skillImportDiscard(plan.stagingId);
      } catch {
        // staging cleanup is best effort
      }
    }
    setPlan(null);
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const applied = await api.skillImportApply(plan.stagingId, [...selected], scope, workspaceId, replace);
      const into = { count: applied.length, scope: scopeLabel(scope) };
      setResult(
        applied.some((a) => a.replaced)
          ? t("Imported {count} skill(s) into the {scope} root; replaced skills were kept as .bak directories. Agents list them for sessions started from now on.", into)
          : t("Imported {count} skill(s) into the {scope} root. Agents list them for sessions started from now on.", into),
      );
      setPlan(null);
      onDone();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const collisions = plan?.skills.filter((s) => selected.has(s.directoryName) && s.collidesWith) ?? [];

  return (
    <div className={`card skill-import ${dropping ? "drop-target" : ""}`}>
      <div className="row wrap">
        <strong>{t("Import skills")}</strong>
        <button className="button button-small" disabled={busy} onClick={() => void stage("folder")} type="button">
          {t("From folder…")}
        </button>
        <button className="button button-small" disabled={busy} onClick={() => void stage("zip")} type="button">
          {t("From .zip…")}
        </button>
        <span className="small muted">
          {t("or drop a skill folder or archive here. A source may hold one skill (SKILL.md at its root) or a bundle of skill folders.")}
        </span>
      </div>
      {result && <p className="small">{result}</p>}

      {plan && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal modal-wide">
            <h2>{t("Review import")}</h2>
            <p className="small muted mono">
              {plan.source} · {plan.sourceKind} · {t("{count} file(s), {size}", { count: plan.entries, size: bytes(plan.totalBytes) })}
            </p>
            {plan.rejected.length > 0 && (
              <details>
                <summary className="small chip-warn">
                  {plan.rejected.length === 1
                    ? t("1 entry refused (unsafe path, symlink or git metadata)")
                    : t("{count} entries refused (unsafe path, symlink or git metadata)", { count: plan.rejected.length })}
                </summary>
                <ul className="call-list small">
                  {plan.rejected.map((r) => (
                    <li className="mono" key={r}>
                      {r}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row wrap">
              <span className="small">{t("Install into")}</span>
              {(["project", "user"] as const).map((s) => (
                <label className="check small" key={s}>
                  <input checked={scope === s} disabled={s === "project" && !workspaceId} name="skill-scope" onChange={() => setScope(s)} type="radio" />
                  {s === "project" ? t("this workspace (.agents/skills)") : t("your user (~/.agents/skills)")}
                </label>
              ))}
            </div>
            <ul className="call-list">
              {plan.skills.map((skill) => (
                <li className="card" key={skill.directoryName}>
                  <label className="check">
                    <input
                      checked={selected.has(skill.directoryName)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(skill.directoryName)) next.delete(skill.directoryName);
                        else next.add(skill.directoryName);
                        setSelected(next);
                      }}
                      type="checkbox"
                    />
                    <strong>{skill.frontmatter.name ?? skill.directoryName}</strong>
                    <span className="mono small muted">→ {skill.directoryName}/</span>
                    <span className="small muted">
                      {t("{count} file(s), {size}", { count: skill.files.length, size: bytes(skill.bytes) })}
                    </span>
                    {skill.collidesWith && <span className="chip small chip-warn">{t("already exists in the {scope} root", { scope: scopeLabel(skill.collidesWith) })}</span>}
                    {skill.shadowsOrShadowedBy && (
                      <span className="chip small">
                        {scope === "project"
                          ? t("will shadow the {scope} skill with the same name", { scope: scopeLabel(skill.shadowsOrShadowedBy) })
                          : t("shadowed by the {scope} skill with the same name", { scope: scopeLabel(skill.shadowsOrShadowedBy) })}
                      </span>
                    )}
                  </label>
                  {skill.frontmatter.description && <p className="small muted">{skill.frontmatter.description}</p>}
                  {skill.problems.map((p) => (
                    <p className="small chip-warn" key={p}>
                      {p}
                    </p>
                  ))}
                  <details>
                    <summary className="small muted">{t("files")}</summary>
                    <ul className="call-list small mono">
                      {skill.files.slice(0, 50).map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                      {skill.files.length > 50 && <li className="muted">{t("… {count} more", { count: skill.files.length - 50 })}</li>}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
            {collisions.length > 0 && (
              <label className="check small">
                <input checked={replace} onChange={(e) => setReplace(e.target.checked)} type="checkbox" />{" "}
                {t("Replace the {count} existing skill(s); the current content is kept as a .bak directory next to it", { count: collisions.length })}
              </label>
            )}
            <div className="row wrap">
              <button className="button button-primary" disabled={busy || selected.size === 0 || (collisions.length > 0 && !replace)} onClick={() => void apply()} type="button">
                {selected.size === 1 ? t("Import 1 skill") : t("Import {count} skills", { count: selected.size })}
              </button>
              <button className="button" disabled={busy} onClick={() => void discard()} type="button">
                {t("Cancel")}
              </button>
              <span className="small muted">{t("Agents read the skill catalog when a session starts; start a new session to use imported skills.")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
