/**
 * The Teams view's Import and Export: teams as JSON files (see teamFile).
 * Export picks one or more saved teams and saves them to a file; Import reads
 * a file and adds its teams beside the ones already here.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "../ipc";
import { useStore } from "../store";
import { exportFileName, exportTeams, importedPresets, readTeamsFile } from "../teamFile";
import { t } from "../i18n";

export function TeamsTransfer({ onImported }: { onImported: (firstId: string) => void }) {
  const presets = useStore((s) => s.teamPresets);
  const addTeamPresets = useStore((s) => s.addTeamPresets);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The note says what happened, then goes.
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), note.kind === "ok" ? 4000 : 9000);
    return () => clearTimeout(timer);
  }, [note]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const all = presets.length > 0 && presets.every((preset) => chosen.has(preset.id));
  const picked = presets.filter((preset) => chosen.has(preset.id));

  const save = async () => {
    try {
      const path = await api.saveTextFile(exportFileName(picked), exportTeams(picked));
      if (path === null) return;
      setOpen(false);
      setNote({ kind: "ok", text: picked.length === 1 ? t("Exported “{name}”.", { name: picked[0]?.name ?? "" }) : t("Exported {count} teams.", { count: picked.length }) });
    } catch (error) {
      setNote({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    try {
      const entries = readTeamsFile(await picked.text());
      const added = importedPresets(entries, useStore.getState().teamPresets);
      if (!(await addTeamPresets(added))) return;
      const renamed = added.filter((preset, index) => preset.name !== entries[index]?.name).length;
      setNote({
        kind: "ok",
        text:
          (added.length === 1 ? t("Imported “{name}”.", { name: added[0]?.name ?? "" }) : t("Imported {count} teams.", { count: added.length })) +
          (renamed > 0 ? ` ${t("Names already in use got a number.")}` : ""),
      });
      if (added[0]) onImported(added[0].id);
    } catch (error) {
      setNote({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="teams-transfer" ref={root}>
      {note && (
        <span className={`small teams-transfer-note ${note.kind === "error" ? "teams-transfer-error" : ""}`} role={note.kind === "error" ? "alert" : "status"}>
          {note.text}
        </span>
      )}
      <button className="button" onClick={() => file.current?.click()} title={t("Add teams from a JSON file")} type="button">
        {t("Import…")}
      </button>
      <input accept=".json,application/json" aria-label={t("Team file to import")} className="teams-transfer-file" onChange={(event) => void load(event)} ref={file} type="file" />
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="button"
        disabled={presets.length === 0}
        onClick={() => {
          if (!open) setChosen(new Set(presets.map((preset) => preset.id)));
          setOpen(!open);
        }}
        title={presets.length === 0 ? t("No teams to export yet.") : t("Save teams to a JSON file")}
        type="button"
      >
        {t("Export…")}
      </button>
      {open && (
        <div aria-label={t("Export teams")} className="teams-transfer-pop" role="dialog">
          <span className="model-menu-caption">{t("Teams to export")}</span>
          <label className="teams-transfer-row teams-transfer-all">
            <input checked={all} onChange={() => setChosen(all ? new Set() : new Set(presets.map((preset) => preset.id)))} type="checkbox" />
            {t("All teams")}
          </label>
          <div className="teams-transfer-list">
            {presets.map((preset) => (
              <label className="teams-transfer-row" key={preset.id}>
                <input checked={chosen.has(preset.id)} onChange={() => toggle(preset.id)} type="checkbox" />
                <span className="teams-transfer-name">{preset.name}</span>
              </label>
            ))}
          </div>
          <button className="button button-primary" disabled={picked.length === 0} onClick={() => void save()} type="button">
            {picked.length === 1 ? t("Export 1 team") : t("Export {count} teams", { count: picked.length })}
          </button>
        </div>
      )}
    </div>
  );
}
