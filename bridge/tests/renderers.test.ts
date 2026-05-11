import { describe, it, expect } from "vitest";
import { renderServices, renderBusinessHours } from "../src/prompts/renderers";

describe("renderServices — slug-exposure pattern", () => {
  it("emits [slug] Display Name with duration + price per service", () => {
    const out = renderServices([
      { slug: "tabla_lesson", name: "Tabla Lesson", instructor: "Happy Singh", duration_minutes: 60, price: 50 },
      { slug: "harmonium_lesson", name: "Harmonium Lesson", instructor: "Happy Singh", duration_minutes: 60, price: 40 },
      { slug: "vocal_lesson", name: "Vocal Lesson", instructor: "Riya Sharma", duration_minutes: 45, price: 45 },
    ]);

    expect(out).toContain("use the EXACT slug shown in brackets");
    expect(out).toContain("[tabla_lesson] Tabla Lesson with Happy Singh — 60 minutes, $50");
    expect(out).toContain("[harmonium_lesson] Harmonium Lesson with Happy Singh — 60 minutes, $40");
    expect(out).toContain("[vocal_lesson] Vocal Lesson with Riya Sharma — 45 minutes, $45");
  });

  it("falls back to id when slug is missing", () => {
    const out = renderServices([{ id: "svc_abc", name: "Custom Service", duration_minutes: 30, price: 25 }]);
    expect(out).toContain("[svc_abc] Custom Service");
  });

  it("slug-ifies the name when neither slug nor id is provided", () => {
    const out = renderServices([{ name: "Group Drum Class", duration_minutes: 60 }]);
    expect(out).toContain("[group_drum_class] Group Drum Class");
  });

  it("strips '(Trial)' from the display name but keeps the slug intact", () => {
    const out = renderServices([
      { slug: "tabla_trial", name: "Tabla Lesson (Trial)", duration_minutes: 30, price: 0 },
    ]);
    expect(out).toContain("[tabla_trial] Tabla Lesson");
    expect(out).not.toContain("(Trial)");
  });

  it("skips services with active === false", () => {
    const out = renderServices([
      { slug: "active_one", name: "Active", duration_minutes: 30 },
      { slug: "inactive_one", name: "Inactive", duration_minutes: 30, active: false },
    ]);
    expect(out).toContain("[active_one]");
    expect(out).not.toContain("[inactive_one]");
  });

  it("returns empty string when services list is empty or invalid", () => {
    expect(renderServices([])).toBe("");
    expect(renderServices(null)).toBe("");
    expect(renderServices({ foo: "bar" })).toBe("");
  });

  it("parses JSON-string services_json input", () => {
    const out = renderServices(JSON.stringify([{ slug: "s1", name: "S1", duration_minutes: 30 }]));
    expect(out).toContain("[s1] S1");
  });
});

describe("renderBusinessHours — completeness rule", () => {
  it("lists both open ranges and closed days (in weekday order)", () => {
    const out = renderBusinessHours({
      monday: null,
      tuesday: { open: "10:00", close: "19:00" },
      wednesday: { open: "10:00", close: "19:00" },
      thursday: { open: "10:00", close: "19:00" },
      friday: { open: "10:00", close: "19:00" },
      saturday: { open: "10:00", close: "19:00" },
      sunday: null,
    });
    expect(out).toContain("Tuesday through Saturday from 10am to 7pm");
    expect(out).toContain("Closed Mondays and Sundays");
  });

  it("joins multiple closed days with commas + 'and'", () => {
    const out = renderBusinessHours({
      monday: null,
      tuesday: null,
      wednesday: { open: "10:00", close: "19:00" },
      thursday: { open: "10:00", close: "19:00" },
      friday: { open: "10:00", close: "19:00" },
      saturday: { open: "10:00", close: "19:00" },
      sunday: null,
    });
    expect(out).toContain("Closed Mondays, Tuesdays, and Sundays");
  });
});
