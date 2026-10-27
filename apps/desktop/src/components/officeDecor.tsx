/**
 * Seasonal dressing for the office. Halloween, as the real studio has it:
 * skull garlands and pumpkin-and-ghost lights across the room, cobwebs in the
 * corners, a witch doll on a column, pumpkins in the aisles and a witch's hat
 * on the sofa. A layer of its own, drawn over the room's furniture, so the
 * season can change (or end) by changing one constant.
 */
import { memo } from "react";
import { BRAND, ROOM, drawSprite, type Sprite } from "./officeArt";

export const OFFICE_THEME: "halloween" | "none" = "halloween";

const skull = (body: string, eye: string): Sprite => ({
  rows: [".WWW.", "WWWWW", "WKWKW", "WWWWW", ".WKW.", ".W.W."],
  colors: { W: body, K: eye },
});
const SKULL_WHITE = skull("#f3f0e6", "#23232b");
const SKULL_BLACK = skull("#25252d", "#f3f0e6");

const PUMPKIN: Sprite = {
  rows: ["...gg...", ".OOOgOO.", "OOOOOOOO", "OKOOOKOO", "OOOOOOOO", "OKKKKKKO", ".OOOOOO."],
  colors: { O: BRAND.orange, g: "#3f8f4f", K: "#3a1e08" },
};

const GHOST: Sprite = {
  rows: [".WWWW.", "WWWWWW", "WKWWKW", "WWWWWW", "WWKKWW", "WWWWWW", "WW.WW."],
  colors: { W: "#f6f6fb", K: "#2b2f3a" },
};

const BAT: Sprite = { rows: ["K.....K", "KKKKKKK", ".K.K.K."], colors: { K: "#1b1b24" } };

const WITCH_HAT: Sprite = {
  rows: ["....K....", "...KK....", "...KKK...", "..KKKK...", "..KPPK...", ".KKKKKK..", "KKKKKKKKK"],
  colors: { K: "#1f1f29", P: "#8a4dd0" },
};

const GHOST_PILLOW: Sprite = {
  rows: ["WWWWWW", "WKWWKW", "WPWWPW", "WWKKWW", "WWWWWW", "W.WW.W"],
  colors: { W: "#f6f6fb", K: "#2b2f3a", P: "#f4a6c8" },
};

const WITCH_DOLL: Sprite = {
  rows: [
    "...K....",
    "..KK....",
    ".KKKK...",
    "KKKKKKKK",
    ".OOOOOO.",
    "OOFFFFOO",
    "OOFKFKOO",
    ".OOFFOO.",
    "GKKKKKKG",
    ".KKKKKK.",
    "..KKKK..",
    ".KKKKKK.",
    "KKKKKKKK",
    "P.W..P.W",
  ],
  colors: { K: "#1f1f29", O: "#f07a2a", F: "#e8cfa8", G: "#5fbf5f", P: "#8a4dd0", W: "#f6f6fb" },
};

const SPIDER: Sprite = {
  rows: ["..K..", ".KKK.", "K.K.K"],
  colors: { K: "#1b1b24" },
};

/** A cobweb for a top corner: spokes and two arcs, drawn into the corner. */
function web(size: number): Sprite {
  const rows = Array.from({ length: size }, () => Array<string>(size).fill("."));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.round(Math.hypot(x, y));
      if (x === 0 || y === 0 || x === y || (radius === 5 && Math.abs(x - y) < 6) || radius === 10) (rows[y] as string[])[x] = "w";
    }
  }
  return { rows: rows.map((row) => row.join("")), colors: { w: "#e9e7f0" } };
}
const WEB = web(13);

/** A garland: items hung along a sagging string between two points. */
function garland(from: number, to: number, top: number, sag: number, step: number, items: (index: number) => Sprite, key: string) {
  const mid = (from + to) / 2;
  const half = (to - from) / 2;
  const at = (x: number) => top + Math.round(sag * (1 - ((x - mid) / half) ** 2));
  const string = [];
  for (let x = from; x <= to; x += 1) string.push(<rect fill="#3a3a44" height="1" key={`${key}s${x}`} width="1" x={x} y={at(x)} />);
  const hung = [];
  let index = 0;
  for (let x = from + 3; x <= to - 4; x += step) {
    const sprite = items(index);
    hung.push(drawSprite(sprite, x, at(x) + 1, `${key}${index}`));
    index += 1;
  }
  return (
    <g key={key}>
      {string}
      {hung}
    </g>
  );
}

/** `rows` and `columns` are the desks' layout, `dy` how far the lounge has moved: the decor keeps to the aisles and the lounge. */
export const HalloweenDecor = memo(function HalloweenDecor({ rows, columns, dy }: { rows: number; columns: number; dy: number }) {
  const first = columns === 3 ? 51 : columns === 2 ? 80 : 128;
  const second = columns === 3 ? 102 : columns === 2 ? 80 : 128;
  return (
    <g className="office-halloween">
      {garland(10, 150, 40, 6, 9, (i) => (i % 2 ? SKULL_BLACK : SKULL_WHITE), "skulls")}
      {garland(6, 154, 30, 7, 15, (i) => (i % 3 === 1 ? GHOST : PUMPKIN), "lights")}
      {drawSprite(WEB, 8, 10, "web1")}
      <g transform={`translate(${ROOM.w} 0) scale(-1 1)`}>{drawSprite(WEB, 8, 10, "web2")}</g>
      {drawSprite(SPIDER, 20, 40, "spider")}
      <rect fill="#3a3a44" height="9" width="1" x="22" y="32" />
      <g className="office-bats">
        {drawSprite(BAT, 38, 16, "bat1")}
        {drawSprite(BAT, 112, 14, "bat2")}
        {drawSprite(BAT, 124, 24, "bat3")}
      </g>
      {drawSprite(WITCH_DOLL, 0, 78, "witch")}
      {/* Pumpkins in the aisles between the desks. */}
      <g className="office-glow">
        {rows >= 1 && drawSprite(PUMPKIN, first, 118, "p1")}
        {rows >= 2 && drawSprite(PUMPKIN, second, 162, "p2")}
        {rows >= 3 && drawSprite(PUMPKIN, first, 206, "p3")}
        {drawSprite(PUMPKIN, 140, 100, "p4")}
        <g transform={`translate(0 ${dy})`}>{drawSprite(PUMPKIN, 70, 264, "p5")}</g>
      </g>
      {rows >= 1 && drawSprite(GHOST, second + 1, 120, "g1")}
      {rows >= 2 && drawSprite(GHOST, first, 160, "g2")}
      <g transform={`translate(0 ${dy})`}>
        {drawSprite(WITCH_HAT, 36, 224, "hat")}
        {drawSprite(GHOST_PILLOW, 14, 232, "pillow1")}
        {drawSprite(GHOST_PILLOW, 30, 233, "pillow2")}
      </g>
    </g>
  );
});
