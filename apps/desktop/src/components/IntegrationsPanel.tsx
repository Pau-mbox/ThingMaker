/**
 * Integrations (CTX-01, CFG-10): the instruction files and skills every
 * agent reads, and the runtime environment agents are launched with.
 *
 * Everything is read from files with its source shown and saved with hash
 * checks and a backup. A save is labelled "applies to the next session"
 * because agents read these files when a session starts; nothing here talks
 * to an agent or spends tokens.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { ConfigFile, ConfigTarget, ContextSources, InstructionFileName, SkillEntry, SkillScope } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { api } from "../ipc";
import { basenameOf, useStore } from "../store";

import { SkillImport } from "./SkillImport";
import { RuntimeEnvSection } from "./RuntimeEnvSection";

const CodeEditor = lazy(() => import("./MonacoEditor"));

/** Which provider reads which instruction file, and why both exist. */
const INSTRUCTION_FILES: { file: InstructionFileName; readBy: string }[] = [
  { file: "AGENTS.md", readBy: PROVIDER_LABELS.codex },
  { file: "CLAUDE.md", readBy: PROVIDER_LABELS.claude },
];

function FileEditor({ target, title, onSaved }: { target: ConfigTarget; title: string; onSaved: () => void }) {
  const setError = useStore((s) => s.setError);
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [validation, setValidation] = useState<string[] | null>(null);
  const [draftTouched, setDraftTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.configReadFile(target);
      setFile(loaded);
      setDraft(loaded.content);
      setDraftTouched(false);
      setStatus(null);
      setValidation(loaded.skill && loaded.skill.problems.length > 0 ? loaded.skill.problems : null);
    } catch (error) {
      setError(error);
    }
  }, [JSON.stringify(target), setError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!file) return;
    try {
      const outcome = await api.configWriteFile(target, file.contentHash ?? null, draft);
      setStatus(`Saved to ${outcome.path}. Agents read it when a session starts, so it applies to the next session, not the running one.`);
      setValidation(null);
      onSaved();
      await load();
    } catch (error) {
      setError(error);
    }
  };

  if (!file) return <p className="muted small">Loading {title}…</p>;
  const dirty = draftTouched && draft !== file.content;
  return (
    <div className="config-editor">
      <div className="row wrap">
        <strong>{title}</strong>
        <span className="mono small muted">{file.path}</span>
        {!file.exists && <span className="chip small">does not exist yet</span>}
        <button className="button button-small" disabled={!dirty} onClick={() => void save()} type="button">
          Save (hash-checked, backup kept)
        </button>
        <button className="button button-small" onClick={() => void load()} type="button">
          Reload
        </button>
      </div>
      {validation && validation.length > 0 && (
        <ul className="call-list">
          {validation.map((v) => (
            <li className="small chip-warn" key={v}>
              {v}
            </li>
          ))}
        </ul>
      )}
      {status && <p className="small">{status}</p>}
      <div className="config-editor-body">
        <Suspense fallback={<p className="muted small">Loading editor…</p>}>
          <CodeEditor
            onChange={(value) => {
              setDraft(value);
              setDraftTouched(true);
            }}
            path={file.path}
            readOnly={false}
            value={draft}
          />
        </Suspense>
      </div>
    </div>
  );
}

export function IntegrationsPanel() {
  const setError = useStore((s) => s.setError);
  const workspaces = useStore((s) => s.workspaces);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sources, setSources] = useState<ContextSources | null>(null);
  const [editor, setEditor] = useState<{ target: ConfigTarget; title: string } | null>(null);
  const [newSkill, setNewSkill] = useState<{ scope: SkillScope; name: string }>({ scope: "project", name: "" });
  const [removing, setRemoving] = useState<SkillEntry | null>(null);
  const [keepBackup, setKeepBackup] = useState(true);
  const [removalNote, setRemovalNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSources(workspaceId ? await api.contextSources(workspaceId) : null);
    } catch (error) {
      setError(error);
    }
  }, [workspaceId, setError]);

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      const removed = await api.skillRemove(removing.scope, removing.scope === "project" ? workspaceId : null, removing.directoryName, keepBackup);
      setRemovalNote(
        removed.backup
          ? `Removed ${removed.directoryName}; a copy was kept at ${removed.backup}. Sessions started from now on no longer list it.`
          : `Deleted ${removed.directoryName} permanently. Sessions started from now on no longer list it.`,
      );
      setRemoving(null);
      await reload();
    } catch (error) {
      setError(error);
    }
  };

  useEffect(() => {
    if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const present = (file: InstructionFileName) => sources?.instructionFiles.some((entry) => entry.depth === 0 && entry.path.endsWith(`/${file}`)) ?? false;

  return (
    <div className="panel integrations">
      <h2>Integrations</h2>
      <p className="small muted">
        What every agent reads when a session starts in a workspace. Saving changes a file; it applies to sessions started afterwards. Nothing here talks to an
        agent or spends tokens.
      </p>

      <div className="row wrap">
        <label className="small">
          Workspace{" "}
          <select className="input inline" onChange={(e) => setWorkspaceId(e.target.value)} value={workspaceId ?? ""}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {basenameOf(w.displayPath)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section>
        <h3>Instruction files</h3>
        <p className="small muted">
          Each provider reads its own file from the workspace root and its parents. Keep the shared conventions in one and point the other at it, so every agent
          on the project starts from the same rules.
        </p>
        <ul className="call-list">
          {INSTRUCTION_FILES.map(({ file, readBy }) => (
            <li className="card" key={file}>
              <div className="row wrap">
                <strong className="mono">{file}</strong>
                <span className="chip small">read by {readBy}</span>
                {!present(file) && <span className="chip small muted">not in this workspace yet</span>}
                {workspaceId && (
                  <button className="button button-small" onClick={() => setEditor({ target: { kind: "instructions", workspaceId, file }, title: file })} type="button">
                    {present(file) ? "Edit" : "Create"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {editor && (
        <section>
          <FileEditor onSaved={() => void reload()} target={editor.target} title={editor.title} />
          <button className="link" onClick={() => setEditor(null)} type="button">
            close editor
          </button>
        </section>
      )}

      <section>
        <h3>Skills</h3>
        <p className="small muted">
          Project skills (.agents/skills) shadow user skills (~/.agents/skills) with the same name. Claude Code and Codex both read these folders, list the
          skills when a session starts and load one when the task calls for it, so new skills apply to new sessions.
        </p>
        <SkillImport onDone={() => void reload()} workspaceId={workspaceId} />
        {removalNote && (
          <p className="small">
            {removalNote}{" "}
            <button className="link small" onClick={() => setRemovalNote(null)} type="button">
              dismiss
            </button>
          </p>
        )}
        {removing && (
          <div aria-modal="true" className="modal-backdrop" role="dialog">
            <div className="modal">
              <h2>Remove skill {removing.name ?? removing.directoryName}?</h2>
              <p className="small">
                This removes the {removing.scope} skill directory <span className="mono">{removing.path.replace(/\/SKILL\.md$/, "")}</span> ({removing.resources.length + 1} file
                {removing.resources.length === 0 ? "" : "s"}). Agents stop listing it for sessions started afterwards; running sessions keep the catalog they started with.
              </p>
              <label className="check small">
                <input checked={keepBackup} onChange={(e) => setKeepBackup(e.target.checked)} type="checkbox" /> Keep a copy in the app data folder (skill-backups), so it can be
                restored by copying it back
              </label>
              {!keepBackup && <p className="small chip-warn">Without a backup the files are deleted permanently.</p>}
              <div className="row wrap">
                <button className="button button-warn" onClick={() => void confirmRemove()} type="button">
                  {keepBackup ? "Remove (keep backup)" : "Delete permanently"}
                </button>
                <button className="button" onClick={() => setRemoving(null)} type="button">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {sources?.skills.length === 0 && <p className="small muted">No skills found.</p>}
        <ul className="call-list">
          {sources?.skills.map((skill) => (
            <li className="card" key={skill.path}>
              <div className="row wrap">
                <strong>{skill.name ?? skill.directoryName}</strong>
                <span className="chip small">{skill.scope}</span>
                {skill.shadows && <span className="chip small">shadows the {skill.shadows} skill</span>}
                {skill.shadowed && <span className="chip small chip-warn">shadowed by the project skill</span>}
                {skill.problems.length > 0 && <span className="chip small chip-warn">{skill.problems.join("; ")}</span>}
                <span className="small muted">{skill.resources.length} resource file(s)</span>
                <button
                  className="button button-small"
                  onClick={() =>
                    setEditor({
                      target: { kind: "skill", scope: skill.scope, workspaceId: skill.scope === "project" ? workspaceId : null, directoryName: skill.directoryName },
                      title: `SKILL.md (${skill.scope}/${skill.directoryName})`,
                    })
                  }
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="button button-small button-warn"
                  onClick={() => {
                    setKeepBackup(true);
                    setRemoving(skill);
                  }}
                  type="button"
                >
                  Remove…
                </button>
              </div>
              {skill.description && <p className="small muted">{skill.description}</p>}
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <select className="input inline" onChange={(e) => setNewSkill({ ...newSkill, scope: e.target.value as SkillScope })} value={newSkill.scope}>
            <option value="project">project</option>
            <option value="user">user</option>
          </select>
          <input className="input" onChange={(e) => setNewSkill({ ...newSkill, name: e.target.value })} placeholder="new skill directory name" value={newSkill.name} />
          <button
            className="button"
            disabled={!newSkill.name.trim() || (newSkill.scope === "project" && !workspaceId)}
            onClick={() =>
              api
                .skillCreate(newSkill.scope, newSkill.scope === "project" ? workspaceId : null, newSkill.name.trim())
                .then(() => {
                  setEditor({ target: { kind: "skill", scope: newSkill.scope, workspaceId: newSkill.scope === "project" ? workspaceId : null, directoryName: newSkill.name.trim() }, title: `SKILL.md (${newSkill.scope}/${newSkill.name.trim()})` });
                  setNewSkill({ ...newSkill, name: "" });
                  void reload();
                })
                .catch(setError)
            }
            type="button"
          >
            Create skill from template
          </button>
        </div>
      </section>

      <RuntimeEnvSection />
    </div>
  );
}
