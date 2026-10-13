export type ChillPrefs = {
  economy: boolean;
  freeze: boolean;
  skinId: string;
  skinOptions: Record<string, Record<string, string>>;
  volume: number;
  retention: number;
  pins: string[];
  /** Workspaces left out of the scene; their trouble still raises attention. */
  hidden: string[];
  sound: boolean;
};
export const DEFAULT_PREFS: ChillPrefs = {
  economy: false,
  freeze: false,
  skinId: "terrarium",
  skinOptions: { terrarium: { light: "dusk" } },
  volume: 0.25,
  retention: 24,
  pins: [],
  hidden: [],
  sound: false,
};
export function readPrefs(value: unknown): ChillPrefs {
  if (!value || typeof value !== "object") return { ...DEFAULT_PREFS };
  const v = value as Record<string, unknown>;
  return {
    economy: v.economy === true,
    freeze: v.freeze === true,
    sound: false,
    skinId: typeof v.skinId === "string" ? v.skinId : "terrarium",
    skinOptions: readSkinOptions(v.skinOptions, v.atmosphere),
    volume:
      typeof v.volume === "number" && Number.isFinite(v.volume)
        ? Math.max(0, Math.min(1, v.volume))
        : 0.25,
    retention: [1, 6, 24, 72].includes(Number(v.retention))
      ? Number(v.retention)
      : 24,
    pins: Array.isArray(v.pins)
      ? v.pins.filter((p): p is string => typeof p === "string").slice(0, 500)
      : [],
    hidden: Array.isArray(v.hidden)
      ? v.hidden.filter((p): p is string => typeof p === "string").slice(0, 500)
      : [],
  };
}

function readSkinOptions(
  value: unknown,
  legacy: unknown,
): ChillPrefs["skinOptions"] {
  const result: ChillPrefs["skinOptions"] = {};
  if (value && typeof value === "object")
    for (const [id, options] of Object.entries(value).slice(0, 16)) {
      if (options && typeof options === "object")
        result[id] = Object.fromEntries(
          Object.entries(options)
            .filter(
              ([key, v]) =>
                key.length < 64 && typeof v === "string" && v.length < 128,
            )
            .slice(0, 16),
        ) as Record<string, string>;
    }
  if (!result.terrarium)
    result.terrarium = { light: typeof legacy === "string" ? legacy : "dusk" };
  return result;
}
