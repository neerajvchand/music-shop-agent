import type { Logger } from "../logger";

// Pure renderers — JSON shop settings -> natural-language strings for prompt
// placeholder substitution. Mirrors the subset of app/prompts/renderers.py
// the bridge actually uses at runtime: the five placeholders referenced in
// the current state + persona modules (`{{age_policy_text}}`,
// `{{services_text}}`, `{{talent_on_tour_text}}`, `{{business_hours_text}}`,
// `{{escalation_text}}`).
//
// services_text intentionally DIVERGES from the Python implementation: it
// exposes the service slug in brackets so the LLM can pass verbatim slugs
// to check_availability / create_booking. This prevents a silent failure
// mode where the LLM invents a slug and the tool call rejects it, leaving
// the caller in awkward dead-air.

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_TITLE: Record<string, string> = Object.fromEntries(DAYS.map((d) => [d, d[0].toUpperCase() + d.slice(1)]));

function safe<T>(name: string, fn: () => T, fallback: T, logger?: Logger): T {
  try {
    return fn();
  } catch (err) {
    logger?.warn(`renderer.${name}.error`, { err });
    return fallback;
  }
}

function coerceJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function joinNatural(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatClock(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const hour = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);
  const suffix = hour < 12 ? "am" : "pm";
  const display = hour % 12 || 12;
  return minute === 0 ? `${display}${suffix}` : `${display}:${String(minute).padStart(2, "0")}${suffix}`;
}

// ---------- business hours ----------

export function renderBusinessHours(hoursJson: unknown, logger?: Logger): string {
  return safe("business_hours", () => {
    const hours = coerceJson(hoursJson);
    if (!hours || typeof hours !== "object") return "";
    const h = hours as Record<string, unknown>;

    const openDays: Array<{ day: string; open: string; close: string }> = [];
    const closedDays: string[] = [];
    for (const day of DAYS) {
      const entry = h[day];
      if (entry == null) {
        closedDays.push(day);
      } else if (typeof entry === "object" && entry !== null && "open" in entry && "close" in entry) {
        const e = entry as { open: string; close: string };
        openDays.push({ day, open: e.open, close: e.close });
      } else {
        closedDays.push(day);
      }
    }

    // Group consecutive open days that share the same hours into a range.
    const groups: Array<Array<{ day: string; open: string; close: string }>> = [];
    for (const entry of openDays) {
      const last = groups[groups.length - 1];
      const lastTail = last?.[last.length - 1];
      if (lastTail && lastTail.open === entry.open && lastTail.close === entry.close) {
        const prevIdx = DAYS.indexOf(lastTail.day as (typeof DAYS)[number]);
        const thisIdx = DAYS.indexOf(entry.day as (typeof DAYS)[number]);
        if (thisIdx === prevIdx + 1) {
          last.push(entry);
          continue;
        }
      }
      groups.push([entry]);
    }

    const openPhrases = groups.map((g) => {
      const first = DAY_TITLE[g[0].day];
      const last = DAY_TITLE[g[g.length - 1].day];
      const open = formatClock(g[0].open);
      const close = formatClock(g[0].close);
      return g.length === 1
        ? `${first} from ${open} to ${close}`
        : `${first} through ${last} from ${open} to ${close}`;
    });

    const parts: string[] = [];
    if (openPhrases.length > 0) parts.push("We are open " + joinNatural(openPhrases) + ".");
    if (closedDays.length > 0) {
      const closedPretty = closedDays.map((d) => `${DAY_TITLE[d]}s`);
      parts.push("Closed " + joinNatural(closedPretty) + ".");
    }
    return parts.join(" ");
  }, "", logger);
}

// ---------- services (slug-exposure pattern) ----------

interface ServiceInput {
  id?: string;
  slug?: string;
  name?: string;
  instructor?: string;
  duration_minutes?: number;
  duration_min?: number;
  price?: number;
  mode?: string;
  active?: boolean;
  is_lesson?: boolean;
}

function stripTrial(name: string): string {
  return name.replace(/\s*\(Trial\)/g, "").replace(/\sTrial\b/g, "").trim();
}

function serviceSlug(s: ServiceInput): string {
  // Prefer explicit slug, then id, then a slug-ified name. The renderer's
  // contract: whatever slug we emit must match what create_booking accepts.
  if (s.slug) return s.slug;
  if (s.id) return s.id;
  const name = s.name ?? "";
  return stripTrial(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function renderServices(servicesJson: unknown, logger?: Logger): string {
  return safe("services", () => {
    const raw = coerceJson(servicesJson);
    if (!Array.isArray(raw)) return "";
    const services = raw.filter((s): s is ServiceInput => !!s && typeof s === "object" && s.active !== false);

    if (services.length === 0) return "";

    const lines: string[] = [];
    for (const s of services) {
      const rawName = s.name ?? "";
      if (!rawName) continue;
      const slug = serviceSlug(s);
      const cleanName = stripTrial(rawName);

      let line = `[${slug}] ${cleanName}`;
      if (s.instructor) line += ` with ${s.instructor}`;
      const duration = s.duration_minutes ?? s.duration_min;
      if (duration) line += ` — ${duration} minutes`;
      if (s.price) line += `, $${s.price}`;
      if (s.mode === "remote") line += " (remote only)";
      else if (s.mode === "in_person" && (s.is_lesson ?? cleanName.toLowerCase().includes("lesson"))) line += " (in person)";

      lines.push(line);
    }

    if (lines.length === 0) return "";

    // Critical phrasing: the slug instruction is the prompt-level discipline
    // that makes the slug-exposure pattern work end-to-end.
    return [
      "We offer the following services. When calling check_availability or create_booking, use the EXACT slug shown in brackets:",
      ...lines.map((l) => `- ${l}`),
    ].join("\n");
  }, "", logger);
}

// ---------- age policy ----------

export function renderAgePolicy(ageJson: unknown, logger?: Logger): string {
  return safe("age_policy", () => {
    const data = coerceJson(ageJson);
    if (!data || typeof data !== "object") return "";
    const d = data as { minimum_age?: number; mode?: string };
    const minimum = d.minimum_age;
    if (!minimum) return "";
    if (d.mode === "hard") return `We start students at age ${minimum} and up.`;
    return `We typically start students around age ${minimum} and up. Some younger students can begin if they're able to focus.`;
  }, "", logger);
}

// ---------- talent on tour ----------

export function renderTalentOnTour(talentJson: unknown, logger?: Logger): string {
  return safe("talent_on_tour", () => {
    const data = coerceJson(talentJson);
    if (!data || typeof data !== "object") return "";
    const instructors = (data as { instructors?: unknown }).instructors;
    if (!Array.isArray(instructors)) return "";

    const lines: string[] = [];
    for (const entry of instructors) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { instructor_name?: string; description?: string; route_to?: string };
      const name = e.instructor_name;
      if (!name) continue;
      const desc = e.description ?? "";
      const route = e.route_to ?? "callback_only";
      const first = name.split(/\s+/)[0];

      if (route === "start_with_other_instructor") {
        lines.push(
          `${name} is ${desc}. We can absolutely get you started now with another instructor so you're prepared when ${first} is in session again.`,
        );
      } else if (route === "callback_only") {
        lines.push(
          `${name} is ${desc}. I can take down your details and have someone follow up about scheduling with ${first}.`,
        );
      } else if (route === "remote_only") {
        lines.push(`${name} is ${desc}. ${first} teaches remotely; we can schedule a remote lesson.`);
      } else {
        lines.push(`${name} is ${desc}.`);
      }
    }
    return lines.join("\n");
  }, "", logger);
}

// ---------- escalation ----------

export function renderEscalation(escJson: unknown, logger?: Logger): string {
  return safe("escalation", () => {
    const data = coerceJson(escJson);
    if (!data || typeof data !== "object") return "";
    const d = data as { live_person_callback?: boolean; callback_sla_text?: string };
    if (!d.live_person_callback) return "";
    const sla = d.callback_sla_text || "shortly";
    return `I can help with most questions, but I can also have someone follow up with you ${sla}. Would you like me to arrange that?`;
  }, "", logger);
}
