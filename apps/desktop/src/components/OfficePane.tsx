/**
 * The office beside the conversation (UX-08): the team from the activity
 * strip, working in a small pixel-art office instead of a row. It sits beside
 * the conversation on any window wide enough for both, can be dragged wider
 * or narrower by its left edge (the width is remembered), and folds into a
 * slim rail for anyone who would rather not see it.
 *
 * It shows the lead and the helpers on the session's team, one desk each, so
 * the room is as big as the team. A roster under the room lists each one with
 * its model, task and state, because the room has no space for all that.
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { t } from "../i18n";
import { OFFICE_WIDTH, clampOfficeWidth, fitImage, setOfficeImage, setOfficeOpen, setOfficeWidth, useOfficeImage, useOfficeOpen, useOfficeWidth, type OfficeSlot } from "../officePrefs";
import { useStore } from "../store";
import { buildCrew } from "./crew";
import { IconChevron, IconImage, IconOffice } from "./icons";
import { OfficeScene } from "./OfficeScene";

/** One spot a person can fill with their own image: pick a file, or take theirs away. */
function ImageSlot({ slot, label }: { slot: OfficeSlot; label: string }) {
  const image = useOfficeImage(slot);
  const [failed, setFailed] = useState(false);
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setOfficeImage(slot, await fitImage(file, slot));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="office-custom-row">
      <span className="office-custom-label">{label}</span>
      <label className="link small">
        {t("Choose image")}
        <input accept="image/*" aria-label={`${label}: ${t("Choose image")}`} className="office-custom-file" onChange={(event) => void pick(event)} type="file" />
      </label>
      {image && (
        <button className="link small" onClick={() => setOfficeImage(slot, null)} type="button">
          {t("Remove")}
        </button>
      )}
      {failed && <span className="office-custom-error">{t("That file is not an image we can read.")}</span>}
    </div>
  );
}

/** The window's width, following it as it changes. */
function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const follow = () => setViewport(window.innerWidth);
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);
  return viewport;
}

/** The office's left edge: drag it, or use the arrow keys, to make the office wider or narrower. */
function ResizeEdge({ width, viewport, onLive }: { width: number; viewport: number; onLive: (width: number | null) => void }) {
  const drag = useRef<{ x: number; width: number; live: number } | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, live: width };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The edge is on the left, so dragging left widens it.
    drag.current.live = clampOfficeWidth(drag.current.width + drag.current.x - event.clientX, viewport);
    onLive(drag.current.live);
  };
  const end = () => {
    if (!drag.current) return;
    setOfficeWidth(drag.current.live);
    drag.current = null;
    onLive(null);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") setOfficeWidth(clampOfficeWidth(width + step, viewport));
    else if (event.key === "ArrowRight") setOfficeWidth(clampOfficeWidth(width - step, viewport));
    else if (event.key === "Home") setOfficeWidth(OFFICE_WIDTH.initial);
    else return;
    event.preventDefault();
  };
  return (
    <div
      aria-label={t("Resize the office")}
      aria-orientation="vertical"
      aria-valuemax={clampOfficeWidth(OFFICE_WIDTH.max, viewport)}
      aria-valuemin={OFFICE_WIDTH.min}
      aria-valuenow={width}
      className="office-resize"
      onDoubleClick={() => setOfficeWidth(OFFICE_WIDTH.initial)}
      onKeyDown={keys}
      onLostPointerCapture={end}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      role="separator"
      tabIndex={0}
      title={t("Drag to resize; double-click for the usual width")}
    />
  );
}

export function OfficePane({ sessionId }: { sessionId: string }) {
  const open = useOfficeOpen();
  const viewport = useViewportWidth();
  const stored = useOfficeWidth();
  const [live, setLive] = useState<number | null>(null);
  const width = live ?? clampOfficeWidth(stored, viewport);
  const wall = useOfficeImage("wall");
  const logo = useOfficeImage("logo");
  const [customizing, setCustomizing] = useState(false);
  const session = useStore((s) => s.sessions[sessionId]);
  const jobs = useStore((s) => s.jobs[sessionId]);
  const team = useStore((s) => s.teams[sessionId]);
  const [now, setNow] = useState(Date.now());

  const projection = session?.projection;
  const foreground = !!projection && (projection.foreground === "running" || projection.foreground === "cancelling" || projection.foreground === "awaiting_user");
  const openJobs = (jobs ?? []).filter((job) => job.status === "starting" || job.status === "running" || job.status === "waiting");
  const busy = foreground || openJobs.length > 0;

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!session || !projection) return null;

  const hasTool = [...projection.toolCalls.values()].some((tool) => tool.status === "in_progress" || tool.status === "pending");
  const phase = foreground
    ? projection.foreground === "cancelling"
      ? t("Cancelling")
      : projection.foreground === "awaiting_user"
        ? t("Waiting for your input")
        : hasTool
          ? t("Running tools")
          : t("Thinking")
    : t("Working in the background");
  const crew = buildCrew({ provider: session.snapshot.provider, foreground, phase, jobs, team, agents: [], now });
  const working = crew.filter((member) => member.state === "working").length;

  if (!open) {
    return (
      <aside aria-label={t("Office")} className="office-pane office-pane-collapsed">
        <button aria-label={t("Show the office")} className="icon-button icon-button-xs" onClick={() => setOfficeOpen(true)} title={t("Show the office")} type="button">
          <IconOffice size={16} />
        </button>
        {working > 0 && <span className="office-badge" title={t("{working} of {total} at work", { working, total: crew.length })}>{working}</span>}
      </aside>
    );
  }

  return (
    <aside aria-label={t("Office")} className={`office-pane ${live !== null ? "office-pane-resizing" : ""}`} style={{ width }}>
      <ResizeEdge onLive={setLive} viewport={viewport} width={width} />
      <div className="office-head">
        <h3>{t("Office")}</h3>
        <span className="office-count">{working > 0 ? t("{working} of {total} at work", { working, total: crew.length }) : t("Quiet: nobody is at a desk")}</span>
        <button aria-label={t("Customize the office")} aria-pressed={customizing} className={`icon-button icon-button-xs ${customizing ? "on" : ""}`} onClick={() => setCustomizing(!customizing)} title={t("Customize the office")} type="button">
          <IconImage size={14} />
        </button>
        <button aria-label={t("Hide the office")} className="icon-button icon-button-xs" onClick={() => setOfficeOpen(false)} title={t("Hide the office")} type="button">
          <IconChevron open={true} size={14} />
        </button>
      </div>
      {customizing && (
        <div className="office-custom">
          <ImageSlot label={t("Wall screen")} slot="wall" />
          <ImageSlot label={t("Picture frame")} slot="logo" />
          <p className="office-custom-note">{t("Your images stay on this device.")}</p>
        </div>
      )}
      <OfficeScene crew={crew} logo={logo} wall={wall} />
      <details className="office-roster" open={crew.length > 1}>
        <summary>{t("Everyone in the office ({n})", { n: crew.length })}</summary>
        <ul>
          {crew.map((member) => (
            <li key={member.key}>
              <span className="office-roster-name">{member.name}</span>
              <span className="office-roster-meta">{[PROVIDER_LABELS[member.provider], member.model, member.kind === "helper" ? t("helper") : t("lead")].filter(Boolean).join(" · ")}</span>
              <span className="office-roster-meta">{member.status}</span>
              {(member.task || member.title) && <span className="office-roster-task">{member.task || member.title}</span>}
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
