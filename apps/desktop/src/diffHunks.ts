/**
 * Splits a unified diff into a reusable file header and individual hunks so a
 * single hunk can be staged or reverted (`git apply` accepts header + hunk).
 */
export type Hunk = { index: number; header: string; body: string; additions: number; deletions: number };

export type ParsedDiff = { fileHeader: string; hunks: Hunk[] };

export function parseHunks(unified: string): ParsedDiff {
  const lines = unified.split("\n");
  const headerLines: string[] = [];
  const hunks: Hunk[] = [];
  let current: string[] | null = null;
  let currentHeader = "";
  const flush = () => {
    if (current && currentHeader) {
      let additions = 0;
      let deletions = 0;
      for (const line of current) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
      hunks.push({ index: hunks.length, header: currentHeader, body: current.join("\n"), additions, deletions });
    }
    current = null;
    currentHeader = "";
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      currentHeader = line;
      current = [];
    } else if (current) {
      current.push(line);
    } else {
      headerLines.push(line);
    }
  }
  flush();
  return { fileHeader: headerLines.filter((l) => l.length > 0).join("\n"), hunks };
}

/** A complete single-hunk patch suitable for `git apply --recount`. */
export function hunkPatch(parsed: ParsedDiff, hunk: Hunk): string {
  const body = hunk.body.replace(/\n+$/, "");
  return `${parsed.fileHeader}\n${hunk.header}\n${body}\n`;
}
