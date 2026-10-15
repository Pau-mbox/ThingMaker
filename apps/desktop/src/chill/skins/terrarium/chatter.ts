import type { Activity } from "./motion";
import { chance } from "./motion";

/**
 * What helpers mutter now and then: whimsy, four words at most. It never
 * claims a real result — the inspection panel says what the work is.
 */
export const CHATTER: Record<Activity, readonly string[]> = {
  editing: [
    "Dropping code here…",
    "Dropping code there…",
    "Flaggerblasting…",
    "Snip snip snip…",
    "Polishing a semicolon…",
    "Refactoring with love…",
    "Tiny tweak incoming…",
    "Untangling spaghetti…",
    "Bolting on bits…",
    "Sprinkling some braces…",
  ],
  reading: [
    "Hmm, interesting…",
    "Reading the fine print…",
    "Sniffing out bugs…",
    "Following the breadcrumbs…",
    "Where's that function…",
    "Grepping intensifies…",
    "Squinting at types…",
    "Leafing through leaves…",
  ],
  running: [
    "Beep boop, building…",
    "Compiling vibes…",
    "Pressing the big button…",
    "Tests, don't fail me…",
    "Whirring and purring…",
    "Rattling the pipeline…",
    "Spinning up gears…",
    "Bzzt… bzzt…",
  ],
  thinking: [
    "Pondering deeply…",
    "Cogitating…",
    "Brain go brrr…",
    "Noodling on it…",
    "Reticulating splines…",
    "Consulting the leaves…",
    "Hatching a plan…",
    "Thinkifying…",
  ],
  idle: ["Zzz…", "Dreaming in YAML…", "Just vibing…", "Counting aphids…", "Nap mode engaged…"],
  waiting: ["Psst, your turn!", "Waiting patiently…", "Tap tap tap…", "Need a human…"],
};

/** The `count`th line a helper says while doing `activity`. */
export function chatterLine(activity: Activity, seed: number, count: number): string {
  const lines = CHATTER[activity];
  return lines[Math.floor(chance(seed, count, 9) * lines.length)]!;
}

/** Seconds until a helper speaks again: now and then, never continuously. */
export function chatterGap(seed: number, count: number): number {
  return count === 0 ? 3 + chance(seed, count, 11) * 12 : 15 + chance(seed, count, 11) * 20;
}

/** How long a line stays up, and how many helpers may talk at once. */
export const CHATTER_SECONDS = 3;
export const CHATTER_AT_ONCE = 2;
