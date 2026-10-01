import { describe, expect, it } from "vitest";
import type { NotificationSettings } from "@thingmaker/contracts";
import { inQuietHours, notificationText, parseClock, shouldNotify } from "./notifications";

const base: NotificationSettings = {
  enabled: true,
  notifyCompleted: true,
  notifyFailed: true,
  notifyNeedsInput: true,
  quietHoursStart: "00:00",
  quietHoursEnd: "00:00",
  mutedWorkspaceIds: [],
  closeBehavior: "ask",
  odysseyMaxContinuations: 10,
};

describe("quiet hours", () => {
  it("parses clocks and wraps midnight", () => {
    expect(parseClock("22:30")).toBe(22 * 60 + 30);
    expect(parseClock("24:00")).toBeNull();
    expect(inQuietHours({ quietHoursStart: "22:00", quietHoursEnd: "07:00" }, 23 * 60)).toBe(true);
    expect(inQuietHours({ quietHoursStart: "22:00", quietHoursEnd: "07:00" }, 6 * 60)).toBe(true);
    expect(inQuietHours({ quietHoursStart: "22:00", quietHoursEnd: "07:00" }, 12 * 60)).toBe(false);
    expect(inQuietHours({ quietHoursStart: "09:00", quietHoursEnd: "17:00" }, 12 * 60)).toBe(true);
    expect(inQuietHours({ quietHoursStart: "09:00", quietHoursEnd: "09:00" }, 9 * 60)).toBe(false);
  });
});

describe("notification policy", () => {
  it("honours master switch, per-kind toggles, muting and quiet hours", () => {
    expect(shouldNotify(base, "completed", "w", 600)).toBe(true);
    expect(shouldNotify({ ...base, enabled: false }, "completed", "w", 600)).toBe(false);
    expect(shouldNotify({ ...base, notifyCompleted: false }, "completed", "w", 600)).toBe(false);
    expect(shouldNotify({ ...base, notifyCompleted: false }, "needs_input", "w", 600)).toBe(true);
    expect(shouldNotify({ ...base, mutedWorkspaceIds: ["w"] }, "failed", "w", 600)).toBe(false);
    expect(shouldNotify({ ...base, quietHoursStart: "22:00", quietHoursEnd: "07:00" }, "failed", "w", 23 * 60)).toBe(false);
    expect(shouldNotify(base, "none", "w", 600)).toBe(false);
  });

  it("never includes prompt content in the body", () => {
    const text = notificationText("completed", "my-project");
    expect(text.body).toContain("my-project");
    expect(text.body).not.toMatch(/prompt|code/i);
  });
});
