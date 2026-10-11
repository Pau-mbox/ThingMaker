import type { ChillPrefs } from "../preferences";
import type { ComponentType } from "react";
import type { ActivityProject, Selection } from "../model";

/** Skin code owns visual interpretation, not activity collection or job control. */
export type SkinOptions = Readonly<Record<string, string>>;
export type ChillRenderState = {
  prefs: ChillPrefs;
  options: SkinOptions;
  reduced: boolean;
  selection: Selection;
  focus: string | null;
  now: number;
};
export interface ChillRenderer {
  update(projects: ActivityProject[], state: ChillRenderState): void;
  destroy(): void;
}
export interface ChillAudio {
  stop(): void;
  suspend(hidden: boolean): void;
  setVolume(volume: number): void;
}
export interface ChillSkin {
  readonly id: string;
  readonly label: string;
  readonly pageSize: { desktop: number; compact: number };
  readonly terms: {
    world: string;
    project: string;
    projects: string;
    actor: string;
    actors: string;
    file: string;
    files: string;
    journal: string;
  };
  readonly settings: readonly {
    key: string;
    label: string;
    defaultValue: string;
    choices: readonly { value: string; label: string }[];
  }[];
  appearance(options: SkinOptions): string;
  createRenderer(
    host: HTMLElement,
    prefs: ChillPrefs,
    select: (selection: Selection) => void,
    onUnavailable: () => void,
  ): Promise<ChillRenderer>;
  createAudio?(): ChillAudio | null;
  StillLife: ComponentType<{
    projects: ActivityProject[];
    select: (selection: Selection) => void;
  }>;
}
