import { useEffect, useState } from "react";
import { api } from "../ipc";
import { useStore } from "../store";
import { IS_REMOTE } from "../remote/mode";
import { DEFAULT_PREFS, readPrefs, type ChillPrefs } from "./preferences";
import { resolveSkin, SKINS, skinOptions } from "./skins/registry";

/** Text belongs in the regular settings screen; Chill itself stays observational. */
export default function ChillPreferences() {
  const chillMode = useStore((s) => s.chillMode);
  const setError = useStore((s) => s.setError);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (chillMode) return;
    setReady(false);
    let disposed = false;
    void api
      .prefGet("chill_preferences")
      .then((value) => {
        if (!disposed) {
          setPrefs(readPrefs(value));
          setReady(true);
        }
      })
      .catch(setError);
    return () => {
      disposed = true;
    };
  }, [chillMode]);
  const skin = resolveSkin(prefs.skinId);
  const options = skinOptions(skin, prefs);
  const update = async (patch: Partial<ChillPrefs>) => {
    const next = { ...prefs, ...patch, sound: false };
    setPrefs(next);
    try {
      await api.prefSet("chill_preferences", next);
    } catch (e) {
      setError(e);
    }
  };
  const clear = async () => {
    setClearing(true);
    try {
      await api.activityClear();
      await update({ pins: [] });
    } catch (e) {
      setError(e);
    } finally {
      setClearing(false);
    }
  };
  return (
    <section>
      <h3>Chill</h3>
      <p className="small muted">
        An observational view of your live workspace. Only its title is written
        on screen; quiet icons control scenery, sound and returning to work.
        Escape returns to the whole scene before leaving.
      </p>
      <fieldset disabled={!ready} style={{ border: 0, padding: 0 }}>
        {SKINS.length > 1 && (
          <label className="small">
            Visual skin{" "}
            <select
              className="select"
              value={skin.id}
              onChange={(e) => void update({ skinId: e.target.value })}
            >
              {SKINS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {skin.settings.map((setting) => (
          <label className="small" key={setting.key}>
            {setting.label}{" "}
            <select
              className="select"
              value={options[setting.key]}
              onChange={(e) =>
                void update({
                  skinOptions: {
                    ...prefs.skinOptions,
                    [skin.id]: { ...options, [setting.key]: e.target.value },
                  },
                })
              }
            >
              {setting.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="small">
          Recent file foliage{" "}
          <select
            className="select"
            value={prefs.retention}
            onChange={(e) => void update({ retention: Number(e.target.value) })}
          >
            {[1, 6, 24, 72].map((h) => (
              <option key={h} value={h}>
                {h} {h === 1 ? "hour" : "hours"}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.economy}
            onChange={(e) => void update({ economy: e.target.checked })}
          />
          Economy rendering (30 fps)
        </label>
        <label className="small">
          Ambience volume{" "}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={prefs.volume}
            onChange={(e) => void update({ volume: Number(e.target.value) })}
          />
        </label>
        <p className="small muted">
          Sound starts muted. Active and pinned files stay prominent. Confirmed
          file metadata is retained for seven days; source files and transcripts
          are separate.
        </p>
        <div className="row wrap">
          {prefs.pins.length > 0 && (
            <button
              className="button"
              onClick={() => void update({ pins: [] })}
            >
              Unpin all foliage
            </button>
          )}
          {!IS_REMOTE && (
            <button
              className="button"
              disabled={clearing}
              onClick={() => void clear()}
            >
              {clearing ? "Clearing…" : "Clear recent activity"}
            </button>
          )}
        </div>
      </fieldset>
    </section>
  );
}
