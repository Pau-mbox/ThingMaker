/**
 * ThingMaker's own updates (REL-03): the button beside Chill, which carries a
 * blue dot while a newer release is waiting, its panel, and the popup offered
 * at startup when the reminder is on. Installing downloads the release,
 * checks its signature, installs it and restarts.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { t } from "../i18n";
import { Markdown } from "../markdown";
import { IconUpdate } from "./icons";

/** Sessions whose work a restart would cut short. */
function useBusySessions(): number {
  return useStore((s) =>
    Object.entries(s.sessions).filter(([id, session]) => {
      const foreground = session.projection.foreground;
      const turn = foreground === "running" || foreground === "cancelling" || foreground === "awaiting_user";
      const jobs = (s.jobs[id] ?? []).some((job) => job.status === "starting" || job.status === "running" || job.status === "waiting");
      return turn || jobs;
    }).length,
  );
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Install and restart, with the download's progress once it starts. */
function InstallButton() {
  const update = useStore((s) => s.appUpdate);
  const installUpdate = useStore((s) => s.installUpdate);
  const installing = update.installing;
  if (installing) {
    const share = installing.total ? Math.min(100, Math.round((100 * installing.downloaded) / installing.total)) : null;
    return (
      <div className="update-progress" role="status">
        <div className="update-meter">
          <span style={{ width: `${share ?? 8}%` }} />
        </div>
        <span className="small muted">
          {share === null ? t("Downloading {mb} MB…", { mb: megabytes(installing.downloaded) }) : share >= 100 ? t("Installing, then restarting…") : t("Downloading… {percent}%", { percent: share })}
        </span>
      </div>
    );
  }
  return (
    <button className="button button-primary" onClick={() => void installUpdate()} type="button">
      {t("Install and restart")}
    </button>
  );
}

function BusyWarning() {
  const busy = useBusySessions();
  if (busy === 0) return null;
  return <p className="small chip-warn-text">{busy === 1 ? t("A session is working; restarting stops it.") : t("{count} sessions are working; restarting stops them.", { count: busy })}</p>;
}

function Notes({ notes }: { notes: string | undefined }) {
  if (!notes) return null;
  return (
    <div className="update-notes">
      <Markdown source={notes} />
    </div>
  );
}

/** The button left of Chill. Its panel says what there is and installs it. */
export function UpdateButton() {
  const update = useStore((s) => s.appUpdate);
  const checkForUpdate = useStore((s) => s.checkForUpdate);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const available = update.available;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const title = available
    ? t("ThingMaker {version} is available", { version: available.version })
    : update.error
      ? t("Could not check for updates")
      : t("Updates");

  return (
    <div className="update-wrap" ref={wrap}>
      <button
        aria-expanded={open}
        aria-label={title}
        className={`icon-button update-button ${available ? "update-ready" : ""}`}
        onClick={() => {
          setOpen(!open);
          if (!open && !available && !update.checking) void checkForUpdate("manual");
        }}
        title={title}
        type="button"
      >
        <IconUpdate size={16} />
        {available && <span aria-hidden="true" className="update-dot" />}
      </button>
      {open && (
        <div className="update-panel" role="dialog" aria-label={t("Updates")}>
          {available ? (
            <>
              <strong>{t("ThingMaker {version} is available", { version: available.version })}</strong>
              {update.current && <span className="small muted">{t("You have {version}.", { version: update.current })}</span>}
              <Notes notes={available.notes} />
              <BusyWarning />
              <InstallButton />
            </>
          ) : update.checking ? (
            <span className="small muted">{t("Checking for updates…")}</span>
          ) : update.error ? (
            <>
              <strong>{t("Could not check for updates")}</strong>
              <span className="small muted update-error">{update.error}</span>
              <button className="button button-small" onClick={() => void checkForUpdate("manual")} type="button">
                {t("Check again")}
              </button>
            </>
          ) : (
            <>
              <strong>{update.current ? t("ThingMaker {version} is up to date", { version: update.current }) : t("ThingMaker is up to date")}</strong>
              <button className="button button-small" onClick={() => void checkForUpdate("manual")} type="button">
                {t("Check again")}
              </button>
            </>
          )}
          {update.error && available && <span className="small chip-warn-text">{update.error}</span>}
        </div>
      )}
    </div>
  );
}

/** Offered once at startup when a newer release is waiting and the reminder is on. */
export function UpdatePrompt() {
  const update = useStore((s) => s.appUpdate);
  const dismiss = useStore((s) => s.dismissUpdatePrompt);
  const available = update.available;
  useEffect(() => {
    if (!update.prompt) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !update.installing) dismiss();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [update.prompt, update.installing, dismiss]);
  if (!update.prompt || !available) return null;
  return (
    <div aria-modal="true" className="modal-backdrop" role="dialog" aria-label={t("Update available")}>
      <div className="modal update-prompt">
        <h2>{t("Update available")}</h2>
        <p>
          {t("ThingMaker {version} is ready to install.", { version: available.version })}
          {update.current && <span className="muted"> {t("You have {version}.", { version: update.current })}</span>}
        </p>
        <Notes notes={available.notes} />
        <BusyWarning />
        {update.error && <p className="small chip-warn-text">{update.error}</p>}
        <div className="row wrap update-prompt-actions">
          <InstallButton />
          {!update.installing && (
            <button className="button" onClick={() => dismiss()} type="button">
              {t("Later")}
            </button>
          )}
          <span className="composer-spacer" />
          {!update.installing && (
            <button className="link small" onClick={() => dismiss(true)} type="button">
              {t("Don't remind me at startup")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
