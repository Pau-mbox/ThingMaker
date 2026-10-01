/**
 * Best-effort redaction for exported terminal logs (TERM-03).
 *
 * This is a preview aid, not a guarantee: the user reviews the redacted text
 * before saving. Patterns favour recall for common token shapes and
 * `NAME=value` assignments whose name looks secret-bearing.
 */

export type Redaction = { label: string; count: number };

const PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { label: "AWS access key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Bearer token", regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { label: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    label: "secret-looking assignment",
    regex: /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/g,
  },
];

export function redactText(text: string): { text: string; redactions: Redaction[] } {
  let output = text;
  const redactions: Redaction[] = [];
  for (const { label, regex } of PATTERNS) {
    let count = 0;
    output = output.replace(regex, (...args: unknown[]) => {
      count += 1;
      if (label === "secret-looking assignment") {
        const name = String(args[1]);
        const separator = String(args[2]);
        return `${name}${separator}[REDACTED]`;
      }
      return `[REDACTED ${label}]`;
    });
    if (count > 0) redactions.push({ label, count });
  }
  return { text: output, redactions };
}
