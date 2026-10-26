/**
 * One subscription window as a short bar of what is left, with the percentage
 * and the window's name. The Providers page and the sidebar footer share it.
 */
import type { UsageWindow } from "@thingmaker/contracts";
import { t } from "../i18n";
import { windowName } from "./UsageLine";

export function UsageMeter({ usage }: { usage: UsageWindow }) {
  const left = Math.max(0, 100 - Math.round(usage.usedPercent));
  const name = windowName(usage.windowSeconds);
  return (
    <span className="provider-meter" title={t("{percent}% left in the {window} window, as the provider last reported it", { percent: left, window: name })}>
      <span className="provider-meter-bar">
        <span className={left < 25 ? "low" : ""} style={{ width: `${left}%` }} />
      </span>
      <b>{left}%</b> {name}
    </span>
  );
}
