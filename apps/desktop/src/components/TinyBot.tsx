/**
 * A tiny pixel robot for a member of the crew.
 *
 * Whose it is: its provider's colours, face and head — Claude square with
 * two bar eyes, Codex a cloud with a `>_` prompt for a face, Gemini a white
 * dome with pointed ears and spark eyes in the logo's colours.
 *
 * What it does on the team: headgear and something in hand — the lead's
 * crown and flag, the coder's headphones and laptop, the artist's beret and
 * brush, the reviewer's glasses and magnifier, the researcher's cap and
 * book, the quick helper's headband and bolt.
 *
 * Three states: idle bobs slowly and blinks; working bobs quicker, glances
 * around, wiggles what it holds and throws bits off its head; done dims,
 * shuts its eyes and stands still. Drawn from pixel maps so it stays crisp;
 * motion stops under reduced motion.
 */
import { memo, type ReactNode } from "react";
import type { Provider } from "@thingmaker/contracts";

export type BotState = "idle" | "working" | "done";
export type BotRole = "lead" | "coder" | "artist" | "reviewer" | "researcher" | "quick";

type Palette = { ball: string; ear: string; shell: string; shade: string; visor: string; eye: string; chassis: string; stick: string };

const BRIGHT: Record<Provider, Palette> = {
  claude: { ball: "#ef8a5b", ear: "#e0784b", shell: "#f6dccb", shade: "#d4a88d", visor: "#2b1e1a", eye: "#ffe9dc", chassis: "#efcdb8", stick: "#8a6a5c" },
  codex: { ball: "#7b98ff", ear: "#5a7cf2", shell: "#e1e8ff", shade: "#a3b4ee", visor: "#151a33", eye: "#d6e2ff", chassis: "#c7d3fb", stick: "#5d6aa6" },
  gemini: { ball: "#4285f4", ear: "#4285f4", shell: "#f7f8fc", shade: "#cfd5e2", visor: "#1a1c24", eye: "#8ab4f8", chassis: "#e6e9f1", stick: "#9aa0b0" },
};

/** Done: the provider's colours, dimmed, so a finished robot still says whose it is. */
const DIM: Record<Provider, Palette> = {
  claude: { ball: "#6b5249", ear: "#5e463d", shell: "#7a6a63", shade: "#5e504a", visor: "#2a2321", eye: "#9a8a83", chassis: "#6b5d57", stick: "#4f423d" },
  codex: { ball: "#4b5478", ear: "#424a6b", shell: "#656b80", shade: "#4f5468", visor: "#1e2030", eye: "#858ba3", chassis: "#5a6075", stick: "#40455a" },
  gemini: { ball: "#55585f", ear: "#55585f", shell: "#7c7f87", shade: "#5f626a", visor: "#23252b", eye: "#8f93a0", chassis: "#6c6f77", stick: "#44474e" },
};

/** Gemini's ears, top to bottom and left then right: the spark's colours. */
const GEMINI_EARS = ["#ea4335", "#ea4335", "#f27b2b", "#9b6fe8", "#fbbc04", "#4285f4", "#a5c83c", "#4285f4", "#34a853", "#34a853"];
const SPARK_EYES = ["#ea4335", "#fbbc04", "#ffffff", "#4285f4", "#34a853"];
const SPARK_BITS = ["#ea4335", "#fbbc04", "#34a853", "#4285f4"];

/** Heads, a row per line: A antenna, S stick, H shell, D shade, E ear, V visor. */
const HEADS: Record<Provider, string[]> = {
  claude: [
    "......AAA......",
    "......AAA......",
    ".......S.......",
    "...HHHHHHHHH...",
    "..HHHHHHHHHHH..",
    ".EHHVVVVVVVHHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    "..HHVVVVVVVHH..",
    "..DHHHHHHHHHD..",
    "...DDDDDDDDD...",
  ],
  // A cloud of a head, two bumps either side of the antenna.
  codex: [
    "......AAA......",
    "......AAA......",
    "....HH.S.HH....",
    "...HHHHHHHHH...",
    "..HHHHHHHHHHH..",
    ".EHHVVVVVVVHHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    ".EHVVVVVVVVVHE.",
    "..HHVVVVVVVHH..",
    "..DHHHHHHHHHD..",
    "...DDDDDDDDD...",
  ],
  // A rounder dome with pointed, spark-like ears.
  gemini: [
    "......AAA......",
    "......AAA......",
    ".......S.......",
    ".....HHHHH.....",
    "...HHHHHHHHH...",
    "..HHVVVVVVVHH..",
    ".EHVVVVVVVVVHE.",
    "EEHVVVVVVVVVHEE",
    ".EHVVVVVVVVVHE.",
    "..HVVVVVVVVVH..",
    "..HHVVVVVVVHH..",
    "...DHHHHHHHD...",
    "....DDDDDDD....",
  ],
};
const BODY = [".....BBBBB.....", "....BBBBBBB....", "....BB...BB...."];

/** Faces: Claude's two bars, Codex's `>_` prompt, Gemini's spark eyes. */
const FACES: Record<Provider, Array<[number, number]>> = {
  claude: [
    [5, 7],
    [5, 8],
    [9, 7],
    [9, 8],
  ],
  codex: [
    [4, 6],
    [5, 7],
    [4, 8],
    [8, 8],
    [9, 8],
    [10, 8],
  ],
  gemini: [
    [5, 6],
    [4, 7],
    [5, 7],
    [6, 7],
    [5, 8],
    [9, 6],
    [8, 7],
    [9, 7],
    [10, 7],
    [9, 8],
  ],
};
const SHUT: Array<[number, number]> = [
  [4, 8],
  [5, 8],
  [9, 8],
  [10, 8],
];

type Art = { at: [number, number]; rows: string[]; colors: Record<string, string>; hidesAntenna?: boolean };

/** What each role wears. */
const HATS: Record<BotRole, Art> = {
  lead: { hidesAntenna: true, at: [4, 0], rows: ["Y..Y..Y", "YYYRYYY", "yyyyyyy"], colors: { Y: "#f5c542", y: "#c99a1e", R: "#e5484d" } },
  artist: { hidesAntenna: true, at: [3, 0], rows: [".....s....", "..PPPPPPP.", "PPPPPPPPPP", "pp........"], colors: { P: "#c2436b", p: "#9e2f53", s: "#9e2f53" } },
  researcher: { hidesAntenna: true, at: [1, 0], rows: [".KKKKKKKKKKK..", "KKKKKKKKKKKKKT", "...kkkkkkk...T", ".............T"], colors: { K: "#30334a", k: "#1f2130", T: "#f5c542" } },
  coder: {
    at: [0, 2],
    rows: ["....GGGGGGG....", "...G.......G...", "...............", "GG...........GG", "GG...........GG", "GL...........LG", "GG...........GG", "GG...........GG", "..G............", "...GL.........."],
    colors: { G: "#3a3d4a", L: "#7bdca8" },
  },
  reviewer: { at: [4, 6], rows: ["LLL.LLL", "L.LLL.L", "L.L.L.L", "LLL.LLL"], colors: { L: "#f2d27a" } },
  quick: { at: [2, 4], rows: ["RRRRRYRRRRR"], colors: { R: "#e5484d", Y: "#ffd84a" } },
};

/** What each role holds, beside it. */
const PROPS: Record<BotRole, Art> = {
  lead: { at: [16, 7], rows: ["PFFF", "PFFF", "PFF.", "P...", "P...", "P...", "P...", "P..."], colors: { P: "#a07a52", F: "#f5c542" } },
  artist: { at: [13, 9], rows: ["....T", "...TT", "..M..", ".W...", "W...."], colors: { T: "#e5484d", M: "#b9bcc8", W: "#a07a52" } },
  reviewer: { at: [13, 9], rows: [".RRR", ".RGR", ".RRR", "H...", "H..."], colors: { R: "#d7dbe6", G: "#9ad0ff", H: "#a07a52" } },
  researcher: { at: [13, 10], rows: ["BBBB", "BWWB", "BBBB", "BBBB"], colors: { B: "#3f7d5c", W: "#f3f0e6" } },
  coder: { at: [12, 11], rows: [".SSSS.", ".SGGS.", ".SSSS.", "KKKKKK"], colors: { S: "#2c2f3a", G: "#7bdca8", K: "#9aa0b0" } },
  quick: { at: [14, 8], rows: ["..YY", ".YY.", "YYYY", ".YY.", "YY.."], colors: { Y: "#ffd84a" } },
};

/** The bits a working robot throws off: where each starts, and its size. */
const BITS: Array<[number, number, number]> = [
  [11, 0, 2],
  [13, 2, 1],
  [12, -2, 1],
  [14, -1, 2],
];

function px(x: number, y: number, fill: string, key: string): ReactNode {
  return <rect fill={fill} height="1" key={key} width="1" x={x} y={y} />;
}

function drawArt(art: Art, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  art.rows.forEach((row, dy) => {
    [...row].forEach((letter, dx) => {
      const fill = art.colors[letter];
      if (fill) out.push(px(art.at[0] + dx, art.at[1] + dy, fill, `${prefix}${dx},${dy}`));
    });
  });
  return out;
}

/** The robot's width for a given height: the drawing is 22 by 21 pixels. */
export function botWidth(size: number): number {
  return (size * 22) / 21;
}

export const TinyBot = memo(function TinyBot({ provider: asked, state, role = null, size = 30, title }: { provider: Provider; state: BotState; role?: BotRole | null; size?: number; title?: string }) {
  // A provider this build does not draw yet looks like Claude's rather than breaking the row.
  const provider: Provider = asked in HEADS ? asked : "claude";
  const done = state === "done";
  const palette = (done ? DIM : BRIGHT)[provider];
  const hat = role ? HATS[role] : null;
  const antenna: ReactNode[] = [];
  const head: ReactNode[] = [];
  let ear = 0;
  [...HEADS[provider], ...BODY].forEach((row, y) => {
    [...row].forEach((letter, x) => {
      const key = `${x},${y}`;
      if (letter === "A") {
        if (!hat?.hidesAntenna) antenna.push(px(x, y, palette.ball, key));
      } else if (letter === "S") {
        if (!hat?.hidesAntenna) head.push(px(x, y, palette.stick, key));
      } else if (letter === "E") {
        head.push(px(x, y, provider === "gemini" && !done ? (GEMINI_EARS[Math.min(ear, GEMINI_EARS.length - 1)] as string) : palette.ear, key));
        ear += 1;
      } else {
        const fill = { H: palette.shell, D: palette.shade, V: palette.visor, B: palette.chassis }[letter];
        if (fill) head.push(px(x, y, fill, key));
      }
    });
  });
  const eyes = (done ? SHUT : FACES[provider]).map(([x, y], index) => px(x, y, provider === "gemini" && !done ? (SPARK_EYES[index % SPARK_EYES.length] as string) : palette.eye, `e${x},${y}`));
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`tinybot tinybot-${provider} tinybot-${state}`}
      height={size}
      role={title ? "img" : undefined}
      shapeRendering="crispEdges"
      viewBox="-2 -4 22 21"
      width={botWidth(size)}
    >
      <g className="tinybot-body">
        <g className="tinybot-glow">{antenna}</g>
        {head}
        {hat && <g className="tinybot-gear">{drawArt(hat, "h")}</g>}
        {role && (
          <g className="tinybot-prop">
            <g className="tinybot-gear">{drawArt(PROPS[role], "p")}</g>
          </g>
        )}
        {/* Last, so glasses frame the face rather than cover it. */}
        <g className="tinybot-eyes">{eyes}</g>
      </g>
      {state === "working" && (
        <g className="tinybot-bits">
          {BITS.map(([x, y, w], index) => (
            <rect className={`tinybot-bit tinybot-bit-${index}`} fill={provider === "gemini" ? SPARK_BITS[index] : palette.ball} height={w} key={index} width={w} x={x} y={y} />
          ))}
        </g>
      )}
    </svg>
  );
});
