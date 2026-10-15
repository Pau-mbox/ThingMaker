import type { ChillPrefs } from "../preferences";
import type { ChillSkin, SkinOptions } from "./types";
import { terrariumSkin } from "./terrarium/skin";
/** Built-in skins only. No discovery, plugins, scripts, or external resources. */
export const SKINS: readonly ChillSkin[] = [terrariumSkin];
export const DEFAULT_SKIN_ID = "terrarium";
export function resolveSkin(id: unknown): ChillSkin {
  return SKINS.find((s) => s.id === id) ?? terrariumSkin;
}
export function skinOptions(skin: ChillSkin, prefs: ChillPrefs): SkinOptions {
  const saved = prefs.skinOptions[skin.id] ?? {};
  return Object.fromEntries(
    skin.settings.map((setting) => [
      setting.key,
      setting.choices.some((c) => c.value === saved[setting.key])
        ? saved[setting.key]!
        : setting.defaultValue,
    ]),
  );
}
