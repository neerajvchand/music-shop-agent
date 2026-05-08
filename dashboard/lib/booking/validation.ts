// DUAL-VALIDATOR PATTERN: This validator is duplicated between Python
// (app/booking/validation.py) and TypeScript (this file) for defense-in-depth.
// If you modify one, modify the other to keep error codes and logic in sync.
// Drift between them produces inconsistent caller experiences depending on
// which entry point caught the error.
//
// Essentials only on this side — duration-aware outside_business_hours,
// missing-field checks, invalid date format, business hours check. The TS
// runtime can rely on the shop row already having a valid timezone string,
// so the timezone-fallback logic from Python isn't reproduced here.

export const DEFAULT_DURATION_MIN = 60;
export const MAX_FUTURE_DAYS = 180;

export type ValidationError = {
  error:
    | "missing_service"
    | "missing_phone"
    | "missing_date"
    | "missing_time"
    | "invalid_date_format"
    | "date_in_past"
    | "date_too_far_future"
    | "outside_business_hours";
  message: string;
};

export type DayHours = { open: string; close: string } | null;
export type BusinessHours = Partial<Record<
  | "monday" | "tuesday" | "wednesday" | "thursday"
  | "friday" | "saturday" | "sunday",
  DayHours
>>;

export type ServiceCatalogEntry = {
  slug?: string;
  id?: string;
  duration_minutes?: number;
  duration_min?: number;
  active?: boolean;
};

export type ShopForValidation = {
  timezone?: string | null;
  business_hours_json?: BusinessHours | null;
  services_json?: ServiceCatalogEntry[] | null;
};

export type BookingArgs = {
  service?: string;
  customerPhone?: string;
  callerPhone?: string;
  // Either date+time or startTime; both shapes accepted.
  date?: string;
  time?: string;
  startTime?: string;
  durationMinutes?: number;
};

const DAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
] as const;

function missing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function findService(
  services: ServiceCatalogEntry[] | null | undefined,
  slug: string,
): ServiceCatalogEntry | null {
  if (!services) return null;
  for (const s of services) {
    if (s.slug === slug || s.id === slug) return s;
  }
  return null;
}

function durationFor(svc: ServiceCatalogEntry | null): number {
  if (!svc) return DEFAULT_DURATION_MIN;
  if (typeof svc.duration_minutes === "number" && svc.duration_minutes > 0) {
    return svc.duration_minutes;
  }
  if (typeof svc.duration_min === "number" && svc.duration_min > 0) {
    return svc.duration_min;
  }
  return DEFAULT_DURATION_MIN;
}

function formatH12(hour: number, minute = 0): string {
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 || 12;
  if (minute === 0) return `${h12}${suffix}`;
  return `${h12}:${minute.toString().padStart(2, "0")}${suffix}`;
}

function naturalJoin(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

function closedDays(hours: BusinessHours): string[] {
  return DAY_KEYS
    .filter((d) => hours[d] === null || hours[d] === undefined)
    .map((d) => `${d.charAt(0).toUpperCase()}${d.slice(1)}s`);
}

function openDayPhrase(hours: BusinessHours): string {
  const open = DAY_KEYS
    .filter((d) => hours[d] && typeof hours[d] === "object")
    .map((d) => `${d.charAt(0).toUpperCase()}${d.slice(1)}`);
  if (open.length === 0) return "";
  if (open.length === 1) return open[0];
  if (open.length === 2) return `${open[0]} or ${open[1]}`;
  return open.slice(0, -1).join(", ") + ", or " + open[open.length - 1];
}

function dayKey(weekday: number): typeof DAY_KEYS[number] {
  // JS Date.getDay() returns 0=Sun..6=Sat. We want 0=Mon..6=Sun.
  const idx = (weekday + 6) % 7;
  return DAY_KEYS[idx];
}

function parseStart(args: BookingArgs): { date: Date; date_str: string; time_str: string } | null {
  const startTime = args.startTime?.trim();
  let dateStr = args.date?.trim();
  let timeStr = args.time?.trim();

  if (!dateStr && startTime && startTime.includes("T")) {
    const [d, rest] = startTime.split("T", 2);
    let t = rest;
    for (const sep of ["+", "Z", "-"]) {
      // Slice off any tz suffix from the time portion (but not the leading minus
      // we already split on as part of the date).
      const idx = t.indexOf(sep);
      if (idx > 0) {
        t = t.slice(0, idx);
        break;
      }
    }
    dateStr = d;
    timeStr = t.split(".")[0];
  }

  if (!dateStr || !timeStr) return null;

  const iso = `${dateStr}T${timeStr}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return { date: parsed, date_str: dateStr, time_str: timeStr };
}

export function validateBookAppointmentArgs(
  args: BookingArgs,
  shop: ShopForValidation,
  callerPhone: string | null = null,
): { ok: true; durationMinutes: number; date: Date } | { ok: false; error: ValidationError } {
  if (missing(args.service)) {
    return {
      ok: false,
      error: {
        error: "missing_service",
        message: "I need to know which service you'd like to book — could you confirm what you're looking for?",
      },
    };
  }

  const phone = args.customerPhone || args.callerPhone;
  if (missing(phone) && missing(callerPhone)) {
    return {
      ok: false,
      error: {
        error: "missing_phone",
        message: "Could you share a phone number we can reach you at?",
      },
    };
  }

  // Accept either {date, time} or {startTime}.
  if (missing(args.date) && missing(args.startTime)) {
    return {
      ok: false,
      error: {
        error: "missing_date",
        message: "I need a confirmed date before I can book. What day works for you?",
      },
    };
  }
  if (missing(args.time) && missing(args.startTime)) {
    return {
      ok: false,
      error: {
        error: "missing_time",
        message: "What time would you like to come in?",
      },
    };
  }

  const parsed = parseStart(args);
  if (!parsed) {
    return {
      ok: false,
      error: {
        error: "invalid_date_format",
        message: "I had trouble parsing that date — could you say it again, like 'Tuesday June 4th'?",
      },
    };
  }

  const now = new Date();
  if (parsed.date.getTime() < now.getTime()) {
    return {
      ok: false,
      error: {
        error: "date_in_past",
        message: "That date has already passed. Want to pick a future day?",
      },
    };
  }

  const maxFuture = new Date(now.getTime() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000);
  if (parsed.date.getTime() > maxFuture.getTime()) {
    return {
      ok: false,
      error: {
        error: "date_too_far_future",
        message: "That's quite far out — could you confirm the date you meant?",
      },
    };
  }

  // Resolve duration from the catalog.
  let duration = DEFAULT_DURATION_MIN;
  const services = shop.services_json || [];
  if (services.length > 0) {
    const svc = findService(services, args.service!);
    if (!svc) {
      return {
        ok: false,
        error: {
          error: "missing_service",
          message: "I couldn't find that service in our catalog — could you confirm what you're looking for?",
        },
      };
    }
    duration = durationFor(svc);
  } else if (typeof args.durationMinutes === "number" && args.durationMinutes > 0) {
    duration = args.durationMinutes;
  }

  // Business hours check (duration-aware).
  const hours = shop.business_hours_json || {};
  if (Object.keys(hours).length > 0) {
    const key = dayKey(parsed.date.getDay());
    const entry = hours[key];

    if (!entry || typeof entry !== "object") {
      const closed = closedDays(hours as BusinessHours);
      const open = openDayPhrase(hours as BusinessHours);
      let message: string;
      if (closed.length > 0 && open) {
        message = `We're closed ${naturalJoin(closed)}. Would ${open} work better?`;
      } else if (closed.length > 0) {
        message = `We're closed ${naturalJoin(closed)}. Could you pick another day?`;
      } else if (open) {
        message = `That's outside our hours. We're open ${open} — what would work?`;
      } else {
        message = "That's outside our hours. Could you pick another time?";
      }
      return { ok: false, error: { error: "outside_business_hours", message } };
    }

    const [openH, openM] = entry.open.split(":").map((p: string) => parseInt(p, 10));
    const [closeH, closeM] = entry.close.split(":").map((p: string) => parseInt(p, 10));

    const startMinute = parsed.date.getHours() * 60 + parsed.date.getMinutes();
    const endMinute = startMinute + duration;
    const openMinute = openH * 60 + openM;
    const closeMinute = closeH * 60 + closeM;

    if (startMinute < openMinute || endMinute > closeMinute) {
      const startStr = formatH12(parsed.date.getHours(), parsed.date.getMinutes());
      const closeStr = formatH12(closeH, closeM);
      return {
        ok: false,
        error: {
          error: "outside_business_hours",
          message: `A ${duration}-minute appointment at ${startStr} would run past our ${closeStr} close. Want to start earlier, or pick another day?`,
        },
      };
    }
  }

  return { ok: true, durationMinutes: duration, date: parsed.date };
}
