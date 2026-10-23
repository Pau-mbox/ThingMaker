/**
 * A tiny pixel robot, one colour per provider, in three states:
 *
 * - idle: bobs slowly and blinks now and then;
 * - working: bobs quicker, glances side to side, and throws bits of work
 *   off its antenna;
 * - done: greyed, eyes shut, still.
 *
 * Drawn from a pixel map so it stays crisp at any size; each part (antenna,
 * eyes, bits) is its own group so the stylesheet can animate it. Motion
 * stops under reduced motion.
 */
import { memo } from "react";
import type { Provider } from "@thingmaker/contracts";

export type BotState = "idle" | "working" | "done";

/** The robot, a row per line. A antenna, S stick, H shell, D shade,
 *  E ear, V visor, O open eye, B body. */
const MAP = [
  "......AAA......",
  "......AAA......",
  ".......S.......",
  "...HHHHHHHHH...",
  "..HHHHHHHHHHH..",
  ".EHHVVVVVVVHHE.",
  ".EHVVVVVVVVVHE.",
  ".EHVVOVVVOVVHE.",
  ".EHVVOVVVOVVHE.",
  ".EHVVVVVVVVVHE.",
  "..HHVVVVVVVHH..",
  "..DHHHHHHHHHD..",
  "...DDDDDDDDD...",
  ".....BBBBB.....",
  "....BBBBBBB....",
  "....BB...BB....",
];

/** Shut eyes, for a robot that is done. */
const SHUT = [
  [4, 8],
  [5, 8],
  [9, 8],
  [10, 8],
];

/** The bits a working robot throws off: where each starts, above its head. */
const BITS = [
  [11, 1, 2],
  [13, 3, 1],
  [12, -1, 1],
  [14, 0, 2],
];

type Run = { x: number; y: number; w: number };

/** Each part's pixels as horizontal runs, so a row of one colour is one rect. */
function runs(letter: string): Run[] {
  const out: Run[] = [];
  MAP.forEach((line, y) => {
    let start = -1;
    for (let x = 0; x <= line.length; x += 1) {
      const on = line[x] === letter || (letter === "V" && line[x] === "O");
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        out.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return out;
}

const PARTS = { A: runs("A"), S: runs("S"), H: runs("H"), D: runs("D"), E: runs("E"), V: runs("V"), O: runs("O"), B: runs("B") };

function Pixels({ list, className }: { list: Run[]; className: string }) {
  return (
    <g className={className}>
      {list.map((run) => (
        <rect height="1" key={`${run.x},${run.y}`} width={run.w} x={run.x} y={run.y} />
      ))}
    </g>
  );
}

export const TinyBot = memo(function TinyBot({ provider, state, size = 30, title }: { provider: Provider; state: BotState; size?: number; title?: string }) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`tinybot tinybot-${provider} tinybot-${state}`}
      height={size}
      role={title ? "img" : undefined}
      shapeRendering="crispEdges"
      viewBox="-1 -4 17 21"
      width={(size * 17) / 21}
    >
      <g className="tinybot-body">
        <g className="tinybot-antenna">
          <Pixels className="tinybot-ball" list={PARTS.A} />
          <Pixels className="tinybot-stick" list={PARTS.S} />
        </g>
        <Pixels className="tinybot-shell" list={PARTS.H} />
        <Pixels className="tinybot-shade" list={PARTS.D} />
        <Pixels className="tinybot-ear" list={PARTS.E} />
        <Pixels className="tinybot-visor" list={PARTS.V} />
        {state === "done" ? (
          <g className="tinybot-eyes">
            {SHUT.map(([x, y]) => (
              <rect height="1" key={`${x},${y}`} width="1" x={x} y={y} />
            ))}
          </g>
        ) : (
          <Pixels className="tinybot-eyes" list={PARTS.O} />
        )}
        <Pixels className="tinybot-chassis" list={PARTS.B} />
      </g>
      {state === "working" && (
        <g className="tinybot-bits">
          {BITS.map(([x, y, w], index) => (
            <rect className={`tinybot-bit tinybot-bit-${index}`} height={w} key={index} width={w} x={x} y={y} />
          ))}
        </g>
      )}
    </svg>
  );
});
