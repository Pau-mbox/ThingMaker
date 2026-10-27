/**
 * The art of the office: a studio with a pale oak floor, pink, yellow and
 * orange columns, white desks with a black monitor and a personal item, and a
 * lounge of corduroy bean bags on a jute rug. The big wall screen and the
 * framed picture beside it are the two spots a person can fill with their own
 * images (see officePrefs). Drawn from pixel maps and small painters on one
 * 160 pixel wide grid (see OfficeScene), so every pixel stays crisp at any size.
 */
import { memo, type ReactNode } from "react";
import type { BotRole } from "./TinyBot";

export type Sprite = { rows: string[]; colors: Record<string, string> };

/** The room is always 160 pixels wide; its height follows the number of desks (see OfficeScene). */
export const ROOM = { w: 160 };

/** The studio's accent colours: one place to retune. */
export const PALETTE = { pink: "#e8338f", magenta: "#d62f86", orange: "#f58a2d", yellow: "#ffd400", white: "#ffffff" };

/** Merge each row's runs of one colour into one rect, so a detailed room stays light. */
export function drawSprite(sprite: Sprite, x: number, y: number, key: string, classes: Record<string, string> = {}): ReactNode {
  const rects: ReactNode[] = [];
  sprite.rows.forEach((row, dy) => {
    let dx = 0;
    while (dx < row.length) {
      const letter = row[dx] as string;
      let end = dx + 1;
      while (end < row.length && row[end] === letter) end += 1;
      const fill = sprite.colors[letter];
      if (fill) rects.push(<rect className={classes[letter]} height="1" key={`${dx},${dy}`} style={{ fill }} width={end - dx} x={dx} y={dy} />);
      dx = end;
    }
  });
  return (
    <g key={key} transform={`translate(${x} ${y})`}>
      {rects}
    </g>
  );
}

/** A sprite painted with rectangles and pixels instead of typed out. */
function paint(w: number, h: number, colors: Record<string, string>, draw: (put: (ch: string, x: number, y: number, w?: number, h?: number) => void) => void): Sprite {
  const grid = Array.from({ length: h }, () => Array<string>(w).fill("."));
  draw((ch, x, y, width = 1, height = 1) => {
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) if (grid[y + dy]?.[x + dx] !== undefined) (grid[y + dy] as string[])[x + dx] = ch;
  });
  return { rows: grid.map((row) => row.join("")), colors };
}

/** A blob: centred runs of the given widths, top to bottom. */
function blob(widths: number[], colors: Record<string, string>, shade = 1, light = 2): Sprite {
  const w = Math.max(...widths);
  return paint(w, widths.length, colors, (put) =>
    widths.forEach((width, y) => {
      const x = Math.floor((w - width) / 2);
      put(y < light ? "b" : y >= widths.length - shade ? "s" : "B", x, y, width);
    }),
  );
}

/* ---------- The desk ---------- */

/** A desk's black monitor, 11 by 10. The screen colour is the desk's: dark idle, code while working. */
export const MONITOR: Sprite = {
  rows: [".KKKKKKKKK.", "KSSSSSSSSSK", "KSLLLSSLLSK", "KSSSSSSSSSK", "KSLLSLLLSSK", "KSSSSSSSSSK", "KSLLLSSSSSK", "KKKKKKKKKKK", "....kkk....", "...kkkkk..."],
  colors: { K: "#23262f", S: "var(--screen)", L: "var(--code)", k: "#4a4f5e" },
};

/** The black ergonomic chair behind the robot, 14 by 7. */
export const CHAIR: Sprite = {
  rows: ["...CCCCCCCC...", "..CcccccccCC..", "..CcccccccCC..", "..CcccccccCC..", "..CcccccccCC..", "...CCCCCCCC...", "......CC......"],
  colors: { C: "#1f2230", c: "#363b50" },
};

/** A personal item for the free half of a desk, 11 by 8: short rows are padded, and a short item stands on the desk. */
function item(rows: string[], colors: Record<string, string>): Sprite {
  const blank = Array(Math.max(0, 8 - rows.length)).fill("");
  return { rows: [...blank, ...rows].map((row) => row.padEnd(11, ".")), colors };
}

/** What each role keeps on its desk, beside its one screen: a desk says who works at it. */
export const DESK_ITEMS: Record<BotRole | "none", Sprite> = {
  // A coffee mug, and a rubber duck to talk the bug through with.
  coder: item(["..s..s", ".s..s", ".CCCCC..YY", ".CcccCC.YYO", ".CcccC.YYYY", ".CcccC.YYYY", ".CCCCC..YY"], { s: "#c9ced9", C: "#e8e4da", c: "#7a4a24", Y: "#ffd84a", O: "#f58a2d" }),
  // An easel with a canvas of colour.
  artist: item(["..WWWWWWW", "..WRRWYYW", "..WRWWWBW", "..WWGGWBW", "..WWWWWWW", "...L...L", "..L.....L", ".L.......L"], { W: "#f6f2ea", R: "#e5484d", Y: "#ffd400", B: "#3a7bd5", G: "#3fae62", L: "#a07a52" }),
  // A checklist on a clipboard, and a magnifying glass.
  reviewer: item(["..HHH", ".PPPPP.BBB", ".PGLLP.BwwB", ".PLLLP.BwwB", ".PGLLP.BwwB", ".PLLLP..BB", ".PGLLP...H", ".PPPPP....H"], { P: "#f3f0e6", H: "#7a6a52", G: "#3fae62", L: "#b9bcc8", B: "#4a4f5e", w: "#bfe3ff" }),
  // A stack of books, and a flask.
  researcher: item([".RRRRRR..N", ".WWWWWW..N", "GGGGGGGG.N", "WWWWWWWW.N", ".BBBBBB.nnn", ".WWWWWW.nPn", ".WWWWWW.nnn"], { R: "#b8483a", W: "#f3f0e6", G: "#3f7d5c", B: "#3a5bb0", N: "#9ad0ff", n: "#7ec3f0", P: "#e8338f" }),
  // A trophy, and a framed photo.
  lead: item([".YYYYYY.FFF", "YYYYYYYYFPF", ".YYYYYY.FPF", "..yYYy..FFF", "...YY", "...YY", "..yyyy", ".yyyyyy"], { Y: "#f5c542", y: "#c99a1e", F: "#a07a52", P: "#f9b4c8" }),
  // An energy drink, and a stopwatch.
  quick: item([".CCCC.SSS", ".BYYB.SWWWS", ".BYYB.SWhWS", ".BYYB.SWWWS", ".BYYB..SSS", ".BBBB....S", ".CCCC"], { C: "#c8ccd6", B: "#2b8f5a", Y: "#ffd84a", S: "#4a4f5e", W: "#f3f0e6", h: "#e5484d" }),
  // A potted plant.
  none: item(["....G.G", "...GGGGG", "....GGG", ".....P", "....PPP", "....PPP"], { G: "#3fae62", P: "#a07a52" }),
};

export const CHAIR_COLORS: Record<BotRole | "none", { C: string; c: string }> = {
  lead: { C: "#9e7a14", c: "#d9ad2c" },
  coder: { C: "#1f2230", c: "#363b50" },
  artist: { C: "#9e2f53", c: "#d6457a" },
  reviewer: { C: "#2d4f86", c: "#4a78bf" },
  researcher: { C: "#2f5e48", c: "#47875f" },
  quick: { C: "#b3641b", c: "#f58a2d" },
  none: { C: "#1f2230", c: "#363b50" },
};

export const DESK_W = 44;
export const DESK_H = 14;

/** The white desk's top and front, in front of the robot: keyboard, mouse, a mug, and the drawers. */
export const DESK_FRONT: Sprite = paint(DESK_W, DESK_H, { h: "#ffffff", T: "#f2f1ec", E: "#cfcdc6", F: "#e4e2db", L: "#2b2f3a", D: "#d9d7ce", d: "#bdbbb2", k: "#6b6f7c", m: "#ffffff", c: "#7a4a24", j: "#a9adbb" }, (put) => {
  put("h", 0, 0, DESK_W);
  put("T", 0, 1, DESK_W, 3);
  put("k", 15, 2, 10);
  put("j", 15, 3, 10);
  put("k", 29, 2, 2);
  put("m", 37, 1, 3, 3);
  put("c", 37, 1, 3);
  put("E", 0, 4, DESK_W);
  put("F", 3, 5, 28, 8);
  put("L", 0, 5, 3, 9);
  put("L", 29, 5, 2, 9);
  put("D", 31, 5, 13, 9);
  put("d", 31, 8, 13);
  put("d", 31, 11, 13);
  put("k", 36, 6, 3);
  put("k", 36, 9, 3);
  put("k", 36, 12, 3);
});

/* ---------- The lounge ---------- */

/** The grey sofa with yellow cushions, 40 by 16. */
export const SOFA: Sprite = paint(40, 16, { G: "#b9bdc6", g: "#9aa0ab", Y: PALETTE.yellow, y: "#e0b400", L: "#2b2f3a", h: "#d3d6dd" }, (put) => {
  put("G", 2, 0, 36, 7);
  put("h", 3, 0, 34);
  put("G", 0, 7, 40, 6);
  put("g", 0, 5, 4, 9);
  put("g", 36, 5, 4, 9);
  put("g", 4, 12, 32);
  put("Y", 9, 2, 8, 7);
  put("y", 9, 8, 8);
  put("Y", 23, 2, 8, 7);
  put("y", 23, 8, 8);
  put("L", 4, 14, 2, 2);
  put("L", 34, 14, 2, 2);
});

export const BEANBAG_TAUPE = blob([6, 10, 13, 15, 16, 16, 15, 12], { B: "#9a8581", b: "#a8978f", s: "#6e5d5b" });
export const BEANBAG_DARK = blob([6, 10, 13, 15, 16, 16, 15, 12], { B: "#44464f", b: "#5a5d68", s: "#2f3138" });
export const BEANBAG_BALL = blob([6, 10, 12, 12, 12, 10, 6], { B: "#3b3d46", b: "#555864", s: "#2a2c33" });

/** The round wooden coffee table on black legs, with a candy box, 26 by 14. */
export const COFFEE_TABLE: Sprite = paint(26, 14, { W: "#e0aa66", w: "#c88f4c", L: "#23262f", P: "#7b3fa0", p: "#a35fd0", n: "#f3f0e6" }, (put) => {
  put("W", 4, 0, 18);
  put("W", 1, 1, 24);
  put("W", 0, 2, 26);
  put("w", 1, 3, 24);
  put("w", 4, 4, 18);
  put("P", 9, 0, 7, 2);
  put("p", 10, 0, 5);
  put("n", 18, 1, 3, 2);
  put("L", 5, 5, 1, 8);
  put("L", 20, 5, 1, 8);
  put("L", 8, 12, 10);
});

/** The glass-fronted fridge of cans, 12 by 22. */
export const FRIDGE: Sprite = paint(12, 22, { K: "#1c1e26", g: "#3a3d4a", r: "#e5484d", y: PALETTE.yellow, b: "#4285f4", G: "#34a853", o: PALETTE.orange, w: "#cfd3de" }, (put) => {
  put("K", 0, 0, 12, 22);
  put("g", 1, 1, 10, 18);
  ["roybG", "bGroy", "yobGr", "Groyb"].forEach((row, i) => [...row].forEach((c, x) => put(c, 2 + x * 2, 2 + i * 4, 1, 3)));
  put("w", 10, 6, 1, 6);
  put("K", 1, 19, 10, 3);
});

export const COFFEE_MACHINE: Sprite = paint(10, 14, { K: "#1c1e26", g: "#3a3d4a", G: "#7bdca8", w: "#f3f0e6" }, (put) => {
  put("K", 0, 0, 10, 14);
  put("g", 1, 1, 8, 4);
  put("G", 2, 2, 2);
  put("g", 2, 6, 6, 5);
  put("w", 4, 8, 2, 3);
  put("g", 0, 12, 10, 2);
});

/** Two stacked cubes, one orange and one pink, 16 by 14. */
export const CUBES: Sprite = paint(16, 14, { O: PALETTE.orange, o: "#ffa65c", P: PALETTE.pink, p: "#f27ab6", d: "#00000033" }, (put) => {
  put("O", 0, 6, 8, 8);
  put("o", 0, 6, 8);
  put("P", 8, 6, 8, 8);
  put("p", 8, 6, 8);
  put("P", 3, 0, 8, 6);
  put("p", 3, 0, 8);
});

export const PLANT: Sprite = {
  rows: [
    ".....G.G......",
    "..G...GG..G...",
    ".GGG..GG.GGG..",
    "..GGG.GGGGG...",
    "G..GGGGGGG..G.",
    ".GGGGLGGLGGGG.",
    "..GGGGGGGGGG..",
    "...GGGGGGGG...",
    "....GG.G.GG...",
    ".......t......",
    ".......t......",
    "......ttt.....",
    ".....WWWWW....",
    ".....WWWWW....",
    "......WWW.....",
  ],
  colors: { G: "#3f9d5c", L: "#7bdca8", t: "#6b4a2c", W: "#f3f0e6" },
};

/* ---------- The walls ---------- */

/** The big wall screen, 54 by 28: a lit gradient until a person puts their own image on it. */
export const TV: Sprite = paint(54, 28, { K: "#16181f", S: "url(#office-tv)", k: "#3a3d4a" }, (put) => {
  put("K", 0, 0, 54, 26);
  put("S", 2, 2, 50, 22);
  put("k", 20, 26, 14, 2);
});

/** A framed picture, 14 by 14: a small landscape until a person puts their own image in it. */
export const FRAME: Sprite = paint(14, 14, { F: "#f6f4ee", W: "#ffffff", s: "#9fd3f2", y: PALETTE.yellow, g: "#4fae62", G: "#2f8f4f" }, (put) => {
  put("F", 0, 0, 14, 14);
  put("W", 1, 1, 12, 12);
  put("s", 2, 2, 10, 6);
  put("y", 8, 3, 2, 2);
  put("g", 2, 8, 10, 4);
  put("G", 2, 9, 6, 3);
});

/** Where each custom image goes, in the room's 160 pixel wide grid: the inside of the wall screen and of the frame. */
export const SLOTS = {
  wall: { x: 55, y: 13, w: 50, h: 22 },
  logo: { x: 37, y: 18, w: 12, h: 12 },
} as const;

/** A window with its roller blind half down, 22 by 18. */
export const WINDOW: Sprite = paint(22, 18, { F: "#f3f1ea", B: "#f7f6f1", b: "#e1ded4", s: "#8fc4ee", g: "#4f9d6a" }, (put) => {
  put("F", 0, 0, 22, 18);
  put("s", 1, 1, 20, 16);
  put("g", 1, 12, 20, 5);
  for (let y = 1; y < 10; y += 1) put(y % 2 ? "B" : "b", 1, y, 20);
  put("b", 1, 10, 20);
  put("F", 10, 1, 2, 16);
});

/** A round column, painted: base colour, a light stripe on its left and a shade on its right. */
export function column(height: number, base: string, light: string, dark: string, width = 8): Sprite {
  return paint(width, height, { B: base, l: light, d: dark }, (put) => {
    put("B", 0, 0, width, height);
    put("l", 1, 0, 2, height);
    put("d", width - 2, 0, 2, height);
  });
}

export const COLUMN_PINK = (height: number) => column(height, "#e6479a", "#f27ab6", "#c22f7e");
export const COLUMN_YELLOW = (height: number) => column(height, PALETTE.yellow, "#ffe45c", "#d9b300");
export const COLUMN_ORANGE = (height: number) => column(height, PALETTE.orange, "#ffa65c", "#cf6f1a");

/** Everything that does not change with the crew. */
/** `h` is the room's height; `dy` how far the lounge has moved from where a three-row office puts it. */
export const Backdrop = memo(function Backdrop({ h, dy, wall, logo }: { h: number; dy: number; wall?: string | null; logo?: string | null }) {
  const speckles = Array.from({ length: 70 }, (_, i) => ({ x: (i * 37) % ROOM.w, y: (i * 11) % 9 }));
  return (
    <>
      <defs>
        <linearGradient id="office-tv" x1="0" x2="1" y1="1" y2="0">
          <stop offset="0" stopColor="#7a8fc9" />
          <stop offset="0.28" stopColor="#ec4a7e" />
          <stop offset="0.62" stopColor="#f58a2d" />
          <stop offset="1" stopColor="#ffe100" />
        </linearGradient>
        <pattern height="10" id="office-planks" patternUnits="userSpaceOnUse" width="40">
          <rect fill="#dcb98a" height="5" width="40" />
          <rect fill="#d4ae7c" height="5" width="40" y="5" />
          <rect fill="#c29f6c" height="1" width="40" y="4" />
          <rect fill="#c29f6c" height="1" width="40" y="9" />
          <rect fill="#c29f6c" height="4" width="1" x="14" />
          <rect fill="#c29f6c" height="4" width="1" x="33" y="5" />
        </pattern>
        <pattern height="4" id="office-jute" patternUnits="userSpaceOnUse" width="4">
          <rect fill="#d7c39b" height="4" width="4" />
          <rect fill="#cbb689" height="1" width="4" y="1" />
          <rect fill="#cbb689" height="1" width="2" x="2" y="3" />
        </pattern>
      </defs>
      {/* The ceiling: pale spray, a white cable tray and a strip light. */}
      <rect fill="#d8cbb8" height="10" width={ROOM.w} />
      {speckles.map((s, i) => <rect fill="#c6b8a3" height="1" key={`s${i}`} width="1" x={s.x} y={s.y} />)}
      <rect fill="#f1efe9" height="3" width={ROOM.w} y="2" />
      {Array.from({ length: 40 }, (_, i) => <rect fill="#cfccc3" height="3" key={`t${i}`} width="1" x={i * 4} y="2" />)}
      <rect fill="#ffffff" height="1" width={ROOM.w} y="8" />
      {/* The wall. */}
      <rect fill="#ece7df" height="30" width={ROOM.w} y="10" />
      <rect fill="#cfc8bc" height="2" width={ROOM.w} y="38" />
      {drawSprite(WINDOW, 14, 14, "w1")}
      {drawSprite(WINDOW, 124, 14, "w2")}
      {drawSprite(TV, 53, 11, "tv")}
      {drawSprite(FRAME, 36, 17, "frame")}
      {wall && <image height={SLOTS.wall.h} href={wall} preserveAspectRatio="xMidYMid slice" width={SLOTS.wall.w} x={SLOTS.wall.x} y={SLOTS.wall.y} />}
      {logo && <image height={SLOTS.logo.h} href={logo} preserveAspectRatio="xMidYMid slice" width={SLOTS.logo.w} x={SLOTS.logo.x} y={SLOTS.logo.y} />}
      <rect fill="#2f6f45" height="1" width="2" x="104" y="20" />
      {/* Ivy hanging from the ceiling. */}
      {Array.from({ length: 22 }, (_, i) => {
        const x = 8 + i * 7;
        const drop = 3 + ((i * 5) % 7);
        return (
          <g key={`ivy${i}`}>
            <rect fill="#3f8f4f" height="2" width="5" x={x} y="10" />
            <rect fill="#2f6f45" height={drop} width="1" x={x + 2} y="12" />
            <rect fill="#4fae62" height="2" width="2" x={x + 1} y={12 + drop} />
          </g>
        );
      })}
      {/* The floor: pale oak. */}
      <rect fill="url(#office-planks)" height={h - 40} width={ROOM.w} y="40" />
      {/* The lead's rug, in the accent colours. */}
      <rect fill="#d9d2c5" height="34" width="76" x="42" y="54" />
      <rect fill={PALETTE.pink} height="10" width="72" x="44" y="56" />
      <rect fill={PALETTE.orange} height="10" width="72" x="44" y="66" />
      <rect fill={PALETTE.yellow} height="10" width="72" x="44" y="76" />
      {/* The columns. */}
      {drawSprite(COLUMN_PINK(h - 78), 0, 10, "col1")}
      {drawSprite(COLUMN_YELLOW(h - 78), 152, 10, "col2")}
      {/* The lounge, on a jute rug. */}
      <g transform={`translate(0 ${dy})`}>
      <rect fill="#a88f5e" height="66" width="150" x="5" y="223" />
      <rect fill="url(#office-jute)" height="62" width="146" x="7" y="225" />
      {drawSprite(CUBES, 94, 230, "cubes")}
      {drawSprite(FRIDGE, 114, 222, "fridge")}
      {drawSprite(COFFEE_MACHINE, 128, 230, "coffee")}
      {drawSprite(PLANT, 142, 224, "plant")}
      {drawSprite(SOFA, 10, 226, "sofa")}
      {drawSprite(COFFEE_TABLE, 56, 250, "table")}
      {drawSprite(BEANBAG_TAUPE, 8, 254, "bean1")}
      {drawSprite(BEANBAG_DARK, 124, 252, "bean2")}
      {drawSprite(BEANBAG_BALL, 96, 258, "ball")}
      {drawSprite(PLANT, 2, 270, "plant2")}
      </g>
    </>
  );
});
