import type { ChillSkin } from "../types";
import { ambience } from "./audio";
import { toTerrarium } from "./model";
import { plantPalette, cssColour } from "./palette";
import "./terrarium.css";

export const terrariumSkin: ChillSkin = {
  id: "terrarium",
  label: "Cyber terrarium",
  pageSize: { desktop: 6, compact: 1 },
  terms: {
    world: "garden",
    project: "plant",
    projects: "plants",
    actor: "helper",
    actors: "helpers",
    file: "leaf",
    files: "leaves",
    journal: "Garden journal",
  },
  settings: [
    {
      key: "light",
      label: "Light",
      defaultValue: "dusk",
      choices: [
        { value: "dusk", label: "Soft dusk" },
        { value: "moonlight", label: "Moonlight" },
        { value: "sunrise", label: "Warm sunrise" },
      ],
    },
  ],
  appearance: (options) => `terrarium-${options.light}`,
  async createRenderer(host, prefs, select, onUnavailable) {
    const { Terrarium } = await import("./Terrarium");
    const scene = await Terrarium.create(host, prefs, select);
    const lost = (event: Event) => {
      event.preventDefault();
      onUnavailable();
    };
    const canvas = host.querySelector("canvas");
    canvas?.addEventListener("webglcontextlost", lost);
    return {
      update(projects, state) {
        scene.update(
          projects.map(toTerrarium),
          state.prefs,
          state.reduced,
          state.selection,
          state.focus,
          state.now,
          state.options.light,
        );
      },
      destroy() {
        canvas?.removeEventListener("webglcontextlost", lost);
        scene.destroy();
      },
    };
  },
  // The audio module is tiny and has no resources until a user requests sound.
  createAudio: ambience,
  StillLife: ({ projects, select }) => (
    <div className="terrarium-still-plants">
      {projects.map((p) => (
        <button
          key={p.id}
          aria-label={`Focus project ${p.name}`}
          onClick={() => select({ kind: "project", id: p.id })}
        >
          <svg viewBox="0 0 100 160" width="90" height="145" aria-hidden="true">
            <path
              d="M50 130Q36 78 50 12M48 74 23 51M48 50 74 28M48 99 76 75"
              fill="none"
              stroke="#ad8661"
              strokeWidth="5"
            />
            <g fill={cssColour(plantPalette(p.id)[0]!)} stroke="#4d7660">
              <ellipse
                cx="23"
                cy="44"
                rx="14"
                ry="24"
                transform="rotate(-35 23 44)"
              />
              <ellipse
                cx="73"
                fill={cssColour(plantPalette(p.id)[2]!)}
                cy="28"
                rx="14"
                ry="24"
                transform="rotate(35 73 28)"
              />
              <ellipse
                cx="74"
                fill={cssColour(plantPalette(p.id)[3]!)}
                cy="77"
                rx="14"
                ry="24"
                transform="rotate(45 74 77)"
              />
              <ellipse cx="48" cy="14" rx="12" ry="22" />
            </g>
            <path d="M24 127H76L68 155H32Z" fill="#b58c72" />
          </svg>
          {projects.length > 1 && (
            <span className="terrarium-project-name">{p.name}</span>
          )}
        </button>
      ))}
    </div>
  ),
};
