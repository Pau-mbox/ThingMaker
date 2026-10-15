import type { ChillPrefs } from "../../preferences";
import type { FileActivity } from "@thingmaker/contracts";
import type {
  ActivityActorView,
  ActivityProject,
  Selection,
} from "../../model";
export type TerrariumActor = ActivityActorView & {
  role: "ladybug" | "beetle" | "bee" | "moth" | "butterfly";
};
export type TerrariumProject = Omit<ActivityProject, "actors"> & {
  bugs: TerrariumActor[];
};
export function toTerrarium(
  project: ActivityProject,
  now = Date.now(),
  selection: Selection = null,
): TerrariumProject {
  return {
    ...project,
    bugs: project.actors
      .filter((actor) => {
        // Attached root sessions remain residents. Old helpers stay in activity
        // history, not on the lawn. Only a live completion gets a short farewell.
        if (!actor.native && !actor.parentId) return true;
        if (selection?.kind === "actor" && selection.id === actor.id)
          return true;
        if (
          ["working", "starting", "waiting", "attention", "failed"].includes(
            actor.status,
          )
        )
          return true;
        return (
          actor.jobId !== null ||
          (!!actor.lastActiveAt && now - actor.lastSeen < 12_000)
        );
      })
      .map((actor) => ({
        ...actor,
        role: roleFor(actor.task, actor.native || !!actor.parentId),
      })),
  };
}
export function roleFor(task: string, child: boolean): TerrariumActor["role"] {
  if (/review|audit|check/i.test(task)) return "bee";
  if (/image|illustrat|artwork|sprite/i.test(task)) return "butterfly";
  if (/research|explor|scout/i.test(task)) return "moth";
  return child ? "beetle" : "ladybug";
}
export function leafScale(
  file: FileActivity,
  now: number,
  pinned = false,
): number {
  if (pinned || file.activeActors.length) return 1;
  if (file.touchedAt === 0) return 0.35;
  const age = Math.max(0, now - file.touchedAt) / 60_000;
  const knots = [
    [0, 1],
    [5, 1],
    [30, 0.8],
    [120, 0.55],
    [1440, 0.28],
  ] as const;
  for (let i = 1; i < knots.length; i++) {
    const [end, b] = knots[i]!;
    const [start, a] = knots[i - 1]!;
    if (age <= end) return a + ((b - a) * (age - start)) / (end - start);
  }
  return 0.25;
}
export function visibleFiles(
  project: TerrariumProject,
  prefs: ChillPrefs,
  now: number,
  focused: boolean,
  selection: Selection,
): { files: FileActivity[]; clustered: number } {
  const eligible = project.files.filter(
    (f) =>
      f.activeActors.length ||
      prefs.pins.includes(f.id) ||
      selection?.id === f.id ||
      (f.touchedAt > 0 && now - f.touchedAt < prefs.retention * 3_600_000),
  );
  eligible.sort(
    (a, b) =>
      Number(selection?.id === b.id) - Number(selection?.id === a.id) ||
      Number(b.activeActors.length > 0) - Number(a.activeActors.length > 0) ||
      Number(prefs.pins.includes(b.id)) - Number(prefs.pins.includes(a.id)) ||
      b.touchedAt - a.touchedAt ||
      a.id.localeCompare(b.id),
  );
  const files = eligible.slice(0, focused ? 80 : 24);
  return { files, clustered: project.files.length - files.length };
}
