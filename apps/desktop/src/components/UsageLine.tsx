/**
 * One-line readout of OpenAI subscription window changes (5-hour and weekly)
 * between two samples. The account counters are shared by everything on the
 * subscription, so the deltas describe usage during the sampled interval.
 */
import type { WindowDelta } from "../store";

export function windowName(seconds: number | undefined): string {
  if (!seconds) return "window";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

export function signed(delta: number | null): string {
  if (delta === null) return "reset";
  return `${delta >= 0 ? "+" : ""}${delta}%`;
}

function Window({ name, delta }: { name: string; delta: WindowDelta | null }) {
  if (!delta) return <span className="muted">{name}: not reported</span>;
  const title = delta.reset
    ? "The window reset between the two samples; the change is not attributable."
    : `${name} window: ${100 - delta.before}% left → ${100 - delta.after}% left (${delta.before}% → ${delta.after}% used)`;
  return (
    <span title={title}>
      {name} {100 - delta.before}% → {100 - delta.after}% left <strong>(used {signed(delta.delta)})</strong>
    </span>
  );
}

export function UsageLine({ label, primary, secondary, primaryName = "5h", secondaryName = "weekly", sampling = false }: {
  label: string;
  primary: WindowDelta | null;
  secondary: WindowDelta | null;
  primaryName?: string;
  secondaryName?: string;
  sampling?: boolean;
}) {
  return (
    <p className="small usage-line">
      <span className="muted">{label}:</span> <Window delta={primary} name={primaryName} /> · <Window delta={secondary} name={secondaryName} />
      {sampling ? <span className="muted"> · sampling…</span> : null}
    </p>
  );
}
