import { describe, expect, it } from "vitest";
import { redactText } from "./redact";

describe("redactText", () => {
  it("masks common token shapes and secret assignments while keeping other text", () => {
    const input = [
      "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "DB_PASSWORD='hunter22'",
      "ls -la ~/project",
    ].join("\n");
    const { text, redactions } = redactText(input);
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toContain("hunter22");
    expect(text).toContain("ls -la ~/project");
    expect(text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(text).toContain("DB_PASSWORD=[REDACTED]");
    expect(redactions.map((r) => r.label)).toEqual(expect.arrayContaining(["OpenAI-style key", "Bearer token", "secret-looking assignment"]));
  });

  it("reports no redactions for ordinary output", () => {
    const { text, redactions } = redactText("cargo test\nrunning 3 tests\n");
    expect(redactions).toEqual([]);
    expect(text).toBe("cargo test\nrunning 3 tests\n");
  });
});
