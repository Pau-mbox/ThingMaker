/**
 * The office: the crew at work, drawn as a pixel-art studio.
 *
 * The lead sits at the head desk; every helper on the team has a desk of its
 * own, and the room is as big as the team: three desks to a row, a row more
 * for every three helpers. A robot with work in flight has its screen lit and
 * a speech bubble saying what it is on; one that is waiting or has finished
 * stays at its desk with the screen dark (the finished ones dimmed), and each
 * desk carries a personal item for its role. Everything comes from the same
 * runtime reports as the activity strip's row — nothing is invented to look
 * busy.
 *
 * The room is a 160 pixel wide grid, 290 tall for three rows of desks (see officeArt), drawn in two layers
 * with the robots between them: the back (walls, floor, chairs, monitors) and
 * the front (the desks' tops and drawers, so a seated robot is half behind
 * its desk). Names, bubbles and plates sit in a third layer above both, so no
 * desk can cover what the room is there to say. Scaled with CSS, so every
 * pixel stays crisp.
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { TinyBot } from "./TinyBot";
import type { CrewMember } from "./crew";
import { useIdleActs, type Act, type Move } from "./officeActs";
import { HalloweenDecor, OFFICE_THEME } from "./officeDecor";
import { Backdrop, CHAIR, CHAIR_COLORS, DESK_FRONT, DESK_H, DESK_ITEMS, DESK_W, MONITOR, ROOM, drawSprite } from "./officeArt";
import "./office.css";

export { ROOM };

/* ---------- Placement ---------- */

const LEAD_DESK = { x: 80, y: 78 };
const DESKS_PER_ROW = 3;
const FIRST_ROW = 124;
const ROW_GAP = 44;
/** The room was drawn for three rows of desks; the lounge and the walls move with the real number. */
const DRAWN_ROWS = 3;
const DRAWN_HEIGHT = 290;

type Desk = { x: number; y: number };
type Place = { x: number; y: number; desk: Desk };

/** The room for a team: a desk for each helper, three to a row, centred; the lounge below them. */
export function layoutFor(helpers: number) {
  const rows = Math.ceil(helpers / DESKS_PER_ROW);
  const columns = Math.max(1, Math.min(DESKS_PER_ROW, helpers));
  const dy = (rows - DRAWN_ROWS) * ROW_GAP;
  const xs = columns === 3 ? [28, 80, 132] : columns === 2 ? [52, 108] : [80];
  return { rows, columns, dy, h: DRAWN_HEIGHT + dy, xs };
}

/** Where each member of the crew sits: the lead at the head desk, every helper at a desk of its own. */
export function placeCrew(crew: CrewMember[]): Place[] {
  const layout = layoutFor(crew.filter((member) => member.kind !== "lead").length);
  let helper = 0;
  return crew.map((member) => {
    const lead = member.role === "lead" || member.kind === "lead";
    const slot = helper;
    if (!lead) helper += 1;
    const desk: Desk = lead ? LEAD_DESK : { x: layout.xs[slot % layout.columns] as number, y: FIRST_ROW + Math.floor(slot / layout.columns) * ROW_GAP };
    return { x: desk.x, y: desk.y - 8, desk };
  });
}

/* ---------- The room ---------- */

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/** A helper is this fraction of the room's width tall; the lead a little more. */
const BOT_SCALE = 0.13;
const LEAD_SCALE = 0.16;
const FALLBACK_WIDTH = 300;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || FALLBACK_WIDTH);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || FALLBACK_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** What a robot has in mind while it does something: a heart, a nap, a cup, a tune. */
function ActIcon({ act }: { act: Act }) {
  switch (act) {
    case "pet":
      return (
        <svg aria-hidden="true" height="12" shapeRendering="crispEdges" viewBox="0 0 7 6" width="14">
          <path d="M1 0h2v1h1V0h2v1h1v2H6v1H5v1H4v1H3V5H2V4H1V3H0V1h1z" fill="#ff5c8a" />
        </svg>
      );
    case "siesta":
      return <span className="office-act-text">z Z</span>;
    case "dance":
      return <span className="office-act-text">♪ ♫</span>;
    default:
      return (
        <svg aria-hidden="true" height="14" shapeRendering="crispEdges" viewBox="0 0 8 8" width="14">
          <path d="M3 0h1v2H3zM5 1h1v1H5z" fill="#c9ced9" />
          <path d="M1 3h5v4H1z" fill="#f3f0e6" />
          <path d="M6 4h1v2H6z" fill="#f3f0e6" />
          <path d="M1 3h5v1H1z" fill="#7a4a24" />
        </svg>
      );
  }
}

/** `wall` and `logo` are a person's own images for the big screen and the framed picture, when they chose any. */
export const OfficeScene = memo(function OfficeScene({ crew, wall = null, logo = null }: { crew: CrewMember[]; wall?: string | null; logo?: string | null }) {
  const places = placeCrew(crew);
  const layout = layoutFor(crew.filter((member) => member.kind !== "lead").length);
  const { ref, width } = useWidth();
  const moves = useIdleActs(crew, places.map((place) => ({ x: place.x, y: place.y })), layout.dy, layout.xs, { enabled: !prefersReducedMotion() });
  const working = crew.filter((member) => member.state === "working").length;
  // Desks that have a robot to call theirs, lit while it works.
  const desks = places.map((place, index) => ({ ...place.desk, key: crew[index]?.key ?? String(index), on: crew[index]?.state === "working", role: (crew[index]?.role ?? "none") as keyof typeof DESK_ITEMS }));
  const layer = { shapeRendering: "crispEdges" as const, viewBox: `0 0 ${ROOM.w} ${layout.h}`, preserveAspectRatio: "none" as const, "aria-hidden": true };

  return (
    <div aria-label={t("The crew's office: {working} of {total} at work", { working, total: crew.length })} className="office-scene" ref={ref} role="img" style={{ aspectRatio: `${ROOM.w} / ${layout.h}` }}>
      <svg {...layer} className="office-layer office-back">
        <Backdrop dy={layout.dy} h={layout.h} logo={logo} wall={wall} />
        {OFFICE_THEME === "halloween" && <HalloweenDecor columns={layout.columns} dy={layout.dy} rows={layout.rows} />}
        {desks.map((desk) => (
          <g className={desk.on ? "office-desk-on" : undefined} key={desk.key}>
            {drawSprite({ ...CHAIR, colors: CHAIR_COLORS[desk.role] }, desk.x - 7, desk.y - DESK_H - 9, `c${desk.key}`)}
            {drawSprite(DESK_ITEMS[desk.role], desk.x - 21, desk.y - DESK_H - 8, `i${desk.key}`)}
            {drawSprite(MONITOR, desk.x + 10, desk.y - DESK_H - 8, `m${desk.key}`, { S: "office-screen" })}
          </g>
        ))}
      </svg>
      {crew.map((member, index) => {
        const place = places[index] as Place;
        const lead = member.kind === "lead";
        const move = moves[member.key];
        const at = move ?? place;
        const style: CSSProperties = { left: pct(at.x, ROOM.w), top: pct(at.y, layout.h), zIndex: Math.round(at.y), ...(move?.walking ? { transition: `left ${move.leg}s linear, top ${move.leg}s linear` } : {}) };
        return (
          <div className={`office-bot office-bot-${member.state} ${move ? "office-standing" : "office-seated"}`} key={member.key} style={style}>
            <div className={`office-body ${move?.walking ? "office-walking" : ""} ${move?.act ? `office-doing-${move.act}` : ""}`}>
              <TinyBot provider={member.provider} role={member.role} size={Math.round(width * (lead ? LEAD_SCALE : BOT_SCALE))} state={member.state} />
            </div>
          </div>
        );
      })}
      <svg {...layer} className="office-layer office-front">
        {desks.map((desk) => (
          <g key={desk.key}>{drawSprite(DESK_FRONT, desk.x - DESK_W / 2, desk.y - DESK_H, `d${desk.key}`)}</g>
        ))}
      </svg>
      {/* Above everything: what each robot is, and what it is doing. */}
      <div className="office-notes">
        {crew.map((member, index) => {
          const place = places[index] as Place;
          const lead = member.kind === "lead";
          const height = (lead ? LEAD_SCALE : BOT_SCALE) * ROOM.w;
          const bubble = member.state === "working" && !lead ? member.title || member.status : "";
          const move = moves[member.key];
          return (
            <div className={`office-note office-note-${member.state}`} key={member.key} title={[member.name, member.model, member.task || member.title].filter(Boolean).join(" · ")}>
              {bubble && (
                <span className="office-bubble" style={{ left: `clamp(24%, ${pct(place.x, ROOM.w)}, 76%)`, top: pct(place.y - height - 3, layout.h) }}>
                  <span className="office-bubble-text">{bubble}</span>
                </span>
              )}
              {move?.act && !move.walking && (
                <span className="office-act" style={{ left: pct(move.x, ROOM.w), top: pct(move.y - height - 1, layout.h) }}>
                  <ActIcon act={move.act} />
                </span>
              )}
              {/* A plate on the front of its desk. */}
              <span className={`office-plate office-plate-desk ${lead ? "office-plate-lead" : ""}`} style={{ left: pct(place.desk.x, ROOM.w), top: pct(place.desk.y - 7, layout.h) }}>
                <span className="office-plate-name">{member.name}</span>
                <span className="office-plate-status">{member.status}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
