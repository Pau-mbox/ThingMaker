/**
 * Reading a checkpoint row of a goal's journal.
 *
 * A checkpoint's `detail` is its progress fingerprint on the first line, then
 * the paths that turn changed, one per line. The Rust engine writes it, along
 * with everything else it reads out of the model's replies; the screen only
 * lists the paths.
 */

/** The paths a checkpoint recorded as changed, if that checkpoint kept them. */
export function checkpointPaths(detail: string | undefined): string[] {
  if (!detail) return [];
  return detail.split("\n").slice(1).filter(Boolean);
}
