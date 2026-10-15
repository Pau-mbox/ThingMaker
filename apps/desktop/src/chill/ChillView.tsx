import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivitySnapshot, WorkspaceRecord } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore, sessionTitle } from "../store";
import { IS_REMOTE } from "../remote/mode";
import { SKINS, resolveSkin, skinOptions } from "./skins/registry";
import type { ChillRenderer, ChillAudio } from "./skins/types";
import { ageLabel, EMPTY, projectsOf, type Selection } from "./model";
import { DEFAULT_PREFS, readPrefs, type ChillPrefs } from "./preferences";
import "./chill.css";

type Preview = { snapshot: ActivitySnapshot; workspaces: WorkspaceRecord[] };
type IconName =
  | "exit"
  | "sound"
  | "silent"
  | "pause"
  | "play"
  | "light"
  | "overview"
  | "left"
  | "right"
  | "source"
  | "attention"
  | "skin"
  | "economy"
  | "pin"
  | "hide";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    exit: (
      <>
        <path d="M9 5H5v14h4M13 8l4 4-4 4M9 12h11" />
      </>
    ),
    sound: (
      <>
        <path d="M10 5 5 9H2v6h3l5 4ZM14 8q5 4 0 8M17 5q8 7 0 14" />
      </>
    ),
    silent: (
      <>
        <path d="M10 5 5 9H2v6h3l5 4ZM15 9l6 6M21 9l-6 6" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7Z" />,
    light: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
      </>
    ),
    overview: (
      <>
        <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    source: (
      <>
        <path d="M14 4h6v6M20 4 10 14M9 5H4v15h15v-5" />
      </>
    ),
    attention: (
      <>
        <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 20h4" />
        <circle cx="18" cy="5" r="2" />
      </>
    ),
    skin: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    pin: (
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />
    ),
    hide: (
      <>
        <path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2" />
        <path d="M4 20 20 4" />
      </>
    ),
    economy: (
      <>
        <path d="M4 8h16M4 16h16" />
        <circle cx="9" cy="8" r="2" />
        <circle cx="15" cy="16" r="2" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/** Shared activity and interaction owner. Visible presentation is observational. */
export default function ChillView({
  onExit,
  preview,
}: {
  onExit: () => void;
  preview?: Preview;
}) {
  const liveWorkspaces = useStore((s) => s.workspaces);
  const liveSessions = useStore((s) => s.sessions);
  const motion = useStore((s) => s.uiPrefs.reducedMotion);
  const workspaces = preview?.workspaces ?? liveWorkspaces;
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(
    preview?.snapshot ?? EMPTY,
  );
  const [connected, setConnected] = useState(!!preview);
  const [prefs, setPrefs] = useState<ChillPrefs>({
    ...DEFAULT_PREFS,
    economy: IS_REMOTE,
  });
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [systemMotion, setSystemMotion] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<ChillRenderer | null>(null);
  const sound = useRef<ChillAudio | null>(null);
  const exitRef = useRef(onExit);
  const selectRef = useRef<(value: Selection) => void>(() => undefined);
  const prefsReady = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  exitRef.current = onExit;
  const skin = resolveSkin(prefs.skinId);
  const reduced = motion === "reduce" || systemMotion;
  const pageSize = IS_REMOTE ? skin.pageSize.compact : skin.pageSize.desktop;
  const everyProject = useMemo(
    () =>
      projectsOf(snapshot, workspaces, now).map((p) =>
        connected
          ? p
          : {
              ...p,
              files: p.files.map((f) => ({ ...f, activeActors: [] })),
              actors: p.actors.map((a) => ({
                ...a,
                status: ["working", "starting"].includes(a.status)
                  ? "unknown"
                  : a.status,
                reason: "Connection interrupted; showing last reported state",
              })),
            },
      ),
    [snapshot, workspaces, now, connected],
  );
  // Hidden projects leave the scene; their trouble still counts below.
  const projects = useMemo(
    () => everyProject.filter((p) => !prefs.hidden.includes(p.id)),
    [everyProject, prefs.hidden],
  );
  const display = projects.slice(page * pageSize, (page + 1) * pageSize);
  const actors = projects.flatMap((p) => p.actors);
  const active = actors.filter((a) =>
    ["working", "starting"].includes(a.status),
  ).length;
  const selectedProject = projects.find(
    (p) =>
      p.id === selection?.id ||
      p.actors.some((a) => a.id === selection?.id) ||
      p.files.some((f) => f.id === selection?.id),
  );
  // The project a hide applies to: the selection's, or the one zoomed into.
  const shownProject = selectedProject ?? projects.find((p) => p.id === focus);
  const selectedActor =
    selection?.kind === "actor"
      ? actors.find((a) => a.id === selection.id)
      : undefined;
  const selectedFile =
    selection?.kind === "file"
      ? selectedProject?.files.find((f) => f.id === selection.id)
      : undefined;
  const attention = everyProject
    .flatMap((p) => p.actors)
    .filter((a) => ["attention", "failed"].includes(a.status));
  const goalAttention = everyProject
    .flatMap((p) => p.goals)
    .filter((g) => g.state === "blocked" || g.pending > 0);
  const otherAttention = preview
    ? []
    : Object.entries(liveSessions).filter(
        ([id, s]) =>
          ["failed", "needs_input"].includes(s.attention) &&
          !attention.some((a) => a.sessionId === id),
      );
  const needsAttention =
    attention.length + goalAttention.length + otherAttention.length > 0;
  const options = useMemo(
    () => skinOptions(skin, prefs),
    [skin, prefs.skinOptions],
  );
  const patch = (value: Partial<ChillPrefs>) =>
    setPrefs((p) => ({ ...p, ...value }));
  const select = (value: Selection, toggle = false) => {
    const project = projects.find(
      (p) =>
        p.id === value?.id ||
        p.actors.some((a) => a.id === value?.id) ||
        p.files.some((f) => f.id === value?.id),
    );
    if (toggle && value?.kind === "project" && focus === project?.id) {
      setSelection(null);
      setFocus(null);
      return;
    }
    setSelection(value);
    if (project) {
      setPage(Math.floor(projects.indexOf(project) / pageSize));
      setFocus(project.id);
    }
  };
  selectRef.current = (value) => select(value, true);

  useEffect(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSystemMotion(media.matches);
    const update = () => setSystemMotion(media.matches);
    media.addEventListener("change", update);
    void api
      .prefGet("chill_preferences")
      .then((v) => {
        const saved = readPrefs(v);
        setPrefs({
          ...saved,
          skinId: resolveSkin(saved.skinId).id,
          economy: IS_REMOTE || saved.economy,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        prefsReady.current = true;
      });
    return () => {
      clearInterval(timer);
      media.removeEventListener("change", update);
      returnFocus.current?.focus?.();
    };
  }, []);
  useEffect(() => {
    if (prefsReady.current)
      void api
        .prefSet("chill_preferences", { ...prefs, sound: false })
        .catch(() => undefined);
  }, [prefs]);
  useEffect(() => {
    if (preview) {
      setSnapshot(preview.snapshot);
      setConnected(true);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (disposed) return;
      if (document.hidden) {
        timer = setTimeout(read, 1500);
        return;
      }
      try {
        const next = await api.activitySnapshot();
        if (!disposed) {
          setSnapshot(next);
          setConnected(true);
          setNow(Date.now());
        }
      } catch {
        if (!disposed) setConnected(false);
      } finally {
        if (!disposed) timer = setTimeout(read, IS_REMOTE ? 1500 : 750);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [preview]);
  useEffect(() => {
    let cancelled = false;
    if (!host.current) return;
    setReady(false);
    setRenderError(false);
    void skin
      .createRenderer(
        host.current,
        prefs,
        (value) => selectRef.current(value),
        () => {
          if (cancelled) return;
          renderer.current?.destroy();
          renderer.current = null;
          setRenderError(true);
          setReady(false);
        },
      )
      .then((scene) => {
        if (cancelled) scene.destroy();
        else {
          renderer.current = scene;
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setRenderError(true);
      });
    return () => {
      cancelled = true;
      renderer.current?.destroy();
      renderer.current = null;
    };
    // Other presentation changes update the existing renderer.
  }, [skin.id]);
  useEffect(() => {
    renderer.current?.update(display, {
      prefs,
      options,
      reduced,
      selection,
      focus,
      now,
    });
  }, [display, prefs, options, reduced, selection, focus, now, ready]);
  useEffect(() => {
    sound.current?.stop();
    sound.current = null;
    setPrefs((p) => ({ ...p, skinId: skin.id, sound: false }));
    return () => {
      sound.current?.stop();
      sound.current = null;
    };
  }, [skin.id]);
  useEffect(() => sound.current?.setVolume(prefs.volume), [prefs.volume]);
  useEffect(() => {
    const hide = () => sound.current?.suspend(document.hidden);
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useStore.getState().paletteOpen) return;
      e.stopPropagation();
      if (focus || selection) {
        setFocus(null);
        setSelection(null);
      } else exitRef.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [focus, selection]);
  useEffect(() => {
    if (focus && !projects.some((p) => p.id === focus)) setFocus(null);
    if (page >= Math.max(1, Math.ceil(projects.length / pageSize))) setPage(0);
  }, [projects, focus, page, pageSize]);

  const navigate = async (
    id?: string,
    workspaceId?: string,
    tab: "transcript" | "changes" | "odyssey" = "transcript",
  ) => {
    try {
      if (id && workspaceId) {
        const state = useStore.getState();
        if (state.sessions[id]) state.selectSession(id);
        else {
          const running = (await api.sessionListOpen()).find(
            (s) => s.handle.id === id || s.agentSessionId === id,
          );
          await state.openSession(workspaceId, {
            mode: "resume",
            session_id: running?.agentSessionId ?? id,
          });
        }
        state.setSessionTab(tab);
      } else if (workspaceId)
        useStore.getState().setView({ kind: "workspace", workspaceId });
      onExit();
    } catch (e) {
      setActionError((e as { message?: string }).message ?? String(e));
    }
  };
  const openSource = () =>
    void navigate(
      selectedActor?.sessionId ?? selectedFile?.sessionId,
      selectedProject?.id,
      selectedFile?.operation === "edit" || selectedFile?.operation === "delete"
        ? "changes"
        : "transcript",
    );
  const openAttention = () => {
    const a = attention[0],
      g = goalAttention[0],
      s = otherAttention[0];
    if (a) void navigate(a.sessionId, a.workspaceId);
    else if (g)
      void navigate(g.sessionId ?? undefined, g.workspaceId, "odyssey");
    else if (s) void navigate(s[0], s[1].workspaceId);
  };
  const toggleSound = () => {
    if (sound.current) {
      sound.current.stop();
      sound.current = null;
      patch({ sound: false });
    } else {
      try {
        sound.current = skin.createAudio?.() ?? null;
        sound.current?.setVolume(prefs.volume);
        patch({ sound: !!sound.current });
      } catch {
        setActionError("Audio is unavailable");
      }
    }
  };
  const overview = () => {
    setFocus(null);
    setSelection(null);
  };
  const status = !connected
    ? "Activity connection interrupted"
    : (actionError ??
      (needsAttention
        ? "Work needs attention"
        : `${projects.length} projects, ${active} active agents`));
  const StillLife = skin.StillLife;
  return (
    <section
      className={`chill chill-skin-${skin.id} ${skin.appearance(options)} ${reduced ? "chill-reduced" : ""}`}
      aria-label="Chill"
      data-preview={preview ? "sample-activity" : undefined}
    >
      <header className="chill-header">
        <nav className="chill-controls" aria-label="Chill controls">
          {SKINS.length > 1 && (
            <button
              aria-label={`Change skin, current ${skin.label}`}
              onClick={() =>
                patch({
                  skinId: SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]!.id,
                })
              }
            >
              <Icon name="skin" />
            </button>
          )}
          {skin.settings.map((setting) => (
            <button
              key={setting.key}
              aria-label={`${setting.label}: ${setting.choices.find((c) => c.value === options[setting.key])?.label}`}
              onClick={() => {
                const next =
                  setting.choices[
                    (setting.choices.findIndex(
                      (c) => c.value === options[setting.key],
                    ) +
                      1) %
                      setting.choices.length
                  ]!;
                patch({
                  skinOptions: {
                    ...prefs.skinOptions,
                    [skin.id]: { ...options, [setting.key]: next.value },
                  },
                });
              }}
            >
              <Icon name="light" />
            </button>
          ))}
          <button
            aria-label={
              prefs.freeze
                ? "Resume scenery"
                : "Freeze scenery; jobs keep running"
            }
            aria-pressed={prefs.freeze}
            onClick={() => patch({ freeze: !prefs.freeze })}
          >
            <Icon name={prefs.freeze ? "play" : "pause"} />
          </button>
          <button
            aria-label={prefs.sound ? "Mute ambience" : "Enable ambience"}
            aria-pressed={prefs.sound}
            onClick={toggleSound}
          >
            <Icon name={prefs.sound ? "sound" : "silent"} />
          </button>
          <button
            aria-label="Economy rendering"
            aria-pressed={prefs.economy}
            onClick={() => patch({ economy: !prefs.economy })}
          >
            <Icon name="economy" />
          </button>
          {prefs.sound && (
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={prefs.volume}
              aria-label="Ambience volume"
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
          )}
          <button aria-label="Back to work" onClick={onExit}>
            <Icon name="exit" />
          </button>
        </nav>
      </header>
      <div className="chill-world" ref={host} role="img" aria-label={status} />
      {renderError && (
        <div className="chill-still">
          <StillLife
            projects={focus ? display.filter((p) => p.id === focus) : display}
            select={(value) => select(value)}
          />
        </div>
      )}
      <nav className="chill-navigation" aria-label="Scene navigation">
        {(focus || selection) && (
          <button aria-label="Whole scene" onClick={overview}>
            <Icon name="overview" />
          </button>
        )}
        {selectedFile && (
          <button
            aria-label={
              prefs.pins.includes(selectedFile.id)
                ? "Unpin selected file"
                : "Pin selected file"
            }
            aria-pressed={prefs.pins.includes(selectedFile.id)}
            onClick={() =>
              patch({
                pins: prefs.pins.includes(selectedFile.id)
                  ? prefs.pins.filter((id) => id !== selectedFile.id)
                  : [...prefs.pins, selectedFile.id].slice(-500),
              })
            }
          >
            <Icon name="pin" />
          </button>
        )}
        {shownProject && (
          <button
            aria-label={`Hide ${shownProject.name} from Chill`}
            onClick={() => {
              overview();
              patch({ hidden: [...prefs.hidden, shownProject.id].slice(-500) });
              setPage(0);
            }}
          >
            <Icon name="hide" />
          </button>
        )}
        {selection && (
          <button aria-label="Open selected work" onClick={openSource}>
            <Icon name="source" />
          </button>
        )}
        {projects.length > pageSize && (
          <>
            <button
              aria-label="Previous scene"
              disabled={page === 0}
              onClick={() => {
                overview();
                setPage((p) => p - 1);
              }}
            >
              <Icon name="left" />
            </button>
            <button
              aria-label="Next scene"
              disabled={(page + 1) * pageSize >= projects.length}
              onClick={() => {
                overview();
                setPage((p) => p + 1);
              }}
            >
              <Icon name="right" />
            </button>
          </>
        )}
      </nav>
      {(needsAttention || !connected || actionError) && (
        <button
          className="chill-attention"
          aria-label={status}
          onClick={needsAttention ? openAttention : onExit}
        >
          <Icon name="attention" />
        </button>
      )}
      <div className="sr-only" aria-label="Activity inspection">
        {projects.map((p) => (
          <div key={p.id}>
            <button
              aria-label={`Focus project ${p.name}`}
              onFocus={() => select({ kind: "project", id: p.id })}
              onClick={() => select({ kind: "project", id: p.id })}
            />
            {p.actors.map((a) => (
              <button
                key={a.id}
                aria-label={`${a.name}, ${a.provider}, ${a.model ?? "model not reported"}, ${a.status}, ${a.task}, ${a.reason ?? ""}`}
                onFocus={() => select({ kind: "actor", id: a.id })}
                onClick={() => select({ kind: "actor", id: a.id })}
              />
            ))}
            {p.files.map((f) => (
              <button
                key={f.id}
                aria-label={`${f.path}, ${f.operation}, ${ageLabel(f.touchedAt, now)}${f.external ? ", external" : ""}`}
                onFocus={() => select({ kind: "file", id: f.id })}
                onClick={() => select({ kind: "file", id: f.id })}
              />
            ))}
          </div>
        ))}
        {otherAttention.map(([id, s]) => (
          <button
            key={id}
            aria-label={`${sessionTitle(s)}, ${s.attention}`}
            onClick={() => void navigate(id, s.workspaceId)}
          />
        ))}
      </div>
    </section>
  );
}
