"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { SettingsSection } from "@/components/SettingsSection";
import { ShopSettings } from "@/lib/settings/schema";

const VOICE_OPTIONS = [
  { id: "aura-2-minerva-en", label: "Minerva (Warm, Professional)" },
  { id: "aura-2-thalia-en", label: "Thalia (Bright, Energetic)" },
  { id: "aura-2-andromeda-en", label: "Andromeda (Calm, Soothing)" },
  { id: "aura-2-hera-en", label: "Hera (Authoritative, Clear)" },
  { id: "aura-2-apollo-en", label: "Apollo (Friendly, Casual)" },
  { id: "aura-2-zeus-en", label: "Zeus (Deep, Confident)" },
];

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const OFF_HOURS_OPTIONS = [
  { value: "voicemail", label: "Send to voicemail" },
  { value: "take_message", label: "Take a message" },
  { value: "offer_callback", label: "Offer a callback" },
];

const MODE_OPTIONS = [
  { value: "in_person", label: "In person" },
  { value: "remote", label: "Remote" },
  { value: "both", label: "Both" },
];

const TALENT_STATUS_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "visiting", label: "Visiting" },
  { value: "away", label: "Away" },
];

const TALENT_ROUTE_OPTIONS = [
  { value: "start_with_other_instructor", label: "Start with another instructor" },
  { value: "callback_only", label: "Callback only" },
  { value: "remote_only", label: "Remote only" },
];

const MENTION_WHEN_OPTIONS = [
  { value: "asked_only", label: "Only when asked" },
  { value: "proactive", label: "Mention proactively" },
  { value: "never", label: "Never mention" },
];

function defaultBusinessHours() {
  const hours: Record<string, { open: string; close: string } | null> = {};
  DAYS.forEach((d) => {
    hours[d] = d === "sunday" ? null : { open: "10:00", close: "17:00" };
  });
  return hours;
}

function defaultSettings(): ShopSettings {
  return {
    greeting: "Thank you for calling! How can I help you today?",
    voice_id: "aura-2-minerva-en",
    business_hours: defaultBusinessHours(),
    services: [],
    booking_buffer_minutes: 15,
    off_hours_behavior: "offer_callback",
    public_phone: null,
    address: null,
    languages: { mirrors: [] },
    rentals: {
      short_term: { enabled: false, day_rate: 0, deposit: 0 },
      monthly_student: { enabled: false, rate: 0 },
    },
    cancellation_policy: {
      enabled: false,
      hours_before: 48,
      percent_charge: 50,
      mention_when: "asked_only",
    },
    payment_portal: { url: null, mention_autopay: false },
    escalation: { live_person_callback: false, callback_sla_text: "shortly" },
    talent_on_tour: { instructors: [] },
    age_policy: { minimum_age: 0, mode: "soft" },
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<ShopSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedSections, setSavedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setSettings({ ...defaultSettings(), ...data });
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load settings");
        setLoading(false);
      });
  }, []);

  const save = useCallback(
    async (partial: Partial<ShopSettings>, sectionKey: string) => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (res.ok) {
        setSavedSections((prev) => ({ ...prev, [sectionKey]: true }));
        setTimeout(() => {
          setSavedSections((prev) => ({ ...prev, [sectionKey]: false }));
        }, 1500);
      } else {
        console.error("Save failed");
      }
    },
    []
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-6">
      <button
        onClick={() => router.push("/")}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </button>

      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      {/* ============================================================ */}
      {/* Section 1 — About this shop                                  */}
      {/* ============================================================ */}
      <SettingsSection
        title="About this shop"
        description="Public phone, address, and language greetings."
        saved={savedSections["about"]}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Public phone</label>
            <input
              type="text"
              value={settings.public_phone ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, public_phone: e.target.value || null }))}
              onBlur={() => save({ public_phone: settings.public_phone }, "about")}
              placeholder="510-555-1234"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Address</label>
            <input
              type="text"
              value={settings.address ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, address: e.target.value || null }))}
              onBlur={() => save({ address: settings.address }, "about")}
              placeholder="123 Main St, City, State, ZIP"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Language greetings
              <span className="ml-2 text-muted-foreground/70">
                (the agent mirrors these greetings, then continues in English)
              </span>
            </label>
            <div className="space-y-2">
              {settings.languages.mirrors.map((m, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Trigger (e.g. Namaste)"
                    value={m.trigger}
                    onChange={(e) => {
                      const mirrors = settings.languages.mirrors.map((x, i) =>
                        i === idx ? { ...x, trigger: e.target.value } : x
                      );
                      setSettings((s) => ({ ...s, languages: { mirrors } }));
                    }}
                    onBlur={() => save({ languages: settings.languages }, "about")}
                    className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Response"
                    value={m.response}
                    onChange={(e) => {
                      const mirrors = settings.languages.mirrors.map((x, i) =>
                        i === idx ? { ...x, response: e.target.value } : x
                      );
                      setSettings((s) => ({ ...s, languages: { mirrors } }));
                    }}
                    onBlur={() => save({ languages: settings.languages }, "about")}
                    className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-sm"
                  />
                  <button
                    onClick={() => {
                      const mirrors = settings.languages.mirrors.filter((_, i) => i !== idx);
                      setSettings((s) => ({ ...s, languages: { mirrors } }));
                      save({ languages: { mirrors } }, "about");
                    }}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const mirrors = [
                    ...settings.languages.mirrors,
                    { trigger: "", response: "" },
                  ];
                  setSettings((s) => ({ ...s, languages: { mirrors } }));
                }}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Add greeting
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 2 — How the agent answers                            */}
      {/* ============================================================ */}
      <SettingsSection
        title="How the agent answers"
        description="The first thing the caller hears, and the voice that says it."
        saved={savedSections["voice"]}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Greeting</label>
            <input
              type="text"
              maxLength={200}
              value={settings.greeting}
              onChange={(e) => setSettings((s) => ({ ...s, greeting: e.target.value }))}
              onBlur={() => save({ greeting: settings.greeting }, "voice")}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {settings.greeting.length}/200
            </p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Voice persona</label>
            <select
              value={settings.voice_id}
              onChange={(e) => {
                const voice_id = e.target.value;
                setSettings((s) => ({ ...s, voice_id }));
                save({ voice_id }, "voice");
              }}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 3 — Hours & off-hours behavior                       */}
      {/* ============================================================ */}
      <SettingsSection
        title="Hours & off-hours behavior"
        saved={savedSections["hours"]}
      >
        <div className="space-y-3">
          {DAYS.map((day) => {
            const hours = settings.business_hours[day];
            const closed = hours === null;
            return (
              <div key={day} className="flex items-center gap-3">
                <span className="w-24 text-sm capitalize">{day}</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!closed}
                    onChange={() => {
                      const business_hours = {
                        ...settings.business_hours,
                        [day]: closed ? { open: "10:00", close: "17:00" } : null,
                      };
                      setSettings((s) => ({ ...s, business_hours }));
                      save({ business_hours }, "hours");
                    }}
                    className="rounded border-border"
                  />
                  Open
                </label>
                {!closed && hours && (
                  <>
                    <input
                      type="time"
                      value={hours.open}
                      onChange={(e) => {
                        const business_hours = {
                          ...settings.business_hours,
                          [day]: { ...hours, open: e.target.value },
                        };
                        setSettings((s) => ({ ...s, business_hours }));
                      }}
                      onBlur={() => save({ business_hours: settings.business_hours }, "hours")}
                      className="px-2 py-1 rounded-md border border-border bg-background text-sm"
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <input
                      type="time"
                      value={hours.close}
                      onChange={(e) => {
                        const business_hours = {
                          ...settings.business_hours,
                          [day]: { ...hours, close: e.target.value },
                        };
                        setSettings((s) => ({ ...s, business_hours }));
                      }}
                      onBlur={() => save({ business_hours: settings.business_hours }, "hours")}
                      className="px-2 py-1 rounded-md border border-border bg-background text-sm"
                    />
                  </>
                )}
              </div>
            );
          })}

          <div className="pt-3 border-t border-border space-y-2">
            <label className="text-xs text-muted-foreground block">Off-hours behavior</label>
            {OFF_HOURS_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-3 p-2 rounded-md cursor-pointer hover:bg-muted"
              >
                <input
                  type="radio"
                  name="off_hours"
                  value={opt.value}
                  checked={settings.off_hours_behavior === opt.value}
                  onChange={() => {
                    const off_hours_behavior = opt.value as ShopSettings["off_hours_behavior"];
                    setSettings((s) => ({ ...s, off_hours_behavior }));
                    save({ off_hours_behavior }, "hours");
                  }}
                />
                <span className="text-sm">{opt.label}</span>
              </label>
            ))}
          </div>

          <div className="pt-3 border-t border-border">
            <label className="text-xs text-muted-foreground block mb-1">
              Booking buffer (minutes between appointments)
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={120}
                step={5}
                value={settings.booking_buffer_minutes}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    booking_buffer_minutes: parseInt(e.target.value),
                  }))
                }
                onBlur={() =>
                  save({ booking_buffer_minutes: settings.booking_buffer_minutes }, "hours")
                }
                className="flex-1"
              />
              <span className="text-sm font-medium w-16 text-right">
                {settings.booking_buffer_minutes} min
              </span>
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 4 — Services & instructors                           */}
      {/* ============================================================ */}
      <SettingsSection
        title="Services & instructors"
        description="What the agent can book, who teaches it, and the age policy."
        saved={savedSections["services"]}
      >
        <div className="space-y-3">
          {settings.services.map((svc, idx) => (
            <div
              key={svc.id}
              className="space-y-2 p-3 rounded-lg border border-border"
            >
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Service name"
                  value={svc.name}
                  onChange={(e) => {
                    const services = settings.services.map((s, i) =>
                      i === idx ? { ...s, name: e.target.value } : s
                    );
                    setSettings((s) => ({ ...s, services }));
                  }}
                  onBlur={() => save({ services: settings.services }, "services")}
                  className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
                <input
                  type="number"
                  min={5}
                  max={480}
                  placeholder="Min"
                  value={svc.duration_minutes}
                  onChange={(e) => {
                    const services = settings.services.map((s, i) =>
                      i === idx ? { ...s, duration_minutes: parseInt(e.target.value) || 0 } : s
                    );
                    setSettings((s) => ({ ...s, services }));
                  }}
                  onBlur={() => save({ services: settings.services }, "services")}
                  className="w-20 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
                <input
                  type="number"
                  min={0}
                  placeholder="$"
                  value={svc.price ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : parseInt(e.target.value);
                    const services = settings.services.map((s, i) =>
                      i === idx ? { ...s, price: v } : s
                    );
                    setSettings((s) => ({ ...s, services }));
                  }}
                  onBlur={() => save({ services: settings.services }, "services")}
                  className="w-20 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={svc.active}
                    onChange={() => {
                      const services = settings.services.map((s, i) =>
                        i === idx ? { ...s, active: !s.active } : s
                      );
                      setSettings((s) => ({ ...s, services }));
                      save({ services }, "services");
                    }}
                    className="rounded border-border"
                  />
                  Active
                </label>
                <button
                  onClick={() => {
                    const services = settings.services.filter((_, i) => i !== idx);
                    setSettings((s) => ({ ...s, services }));
                    save({ services }, "services");
                  }}
                  className="text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Instructor (optional)"
                  value={svc.instructor ?? ""}
                  onChange={(e) => {
                    const services = settings.services.map((s, i) =>
                      i === idx ? { ...s, instructor: e.target.value || null } : s
                    );
                    setSettings((s) => ({ ...s, services }));
                  }}
                  onBlur={() => save({ services: settings.services }, "services")}
                  className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
                <select
                  value={svc.mode}
                  onChange={(e) => {
                    const mode = e.target.value as ShopSettings["services"][number]["mode"];
                    const services = settings.services.map((s, i) =>
                      i === idx ? { ...s, mode } : s
                    );
                    setSettings((s) => ({ ...s, services }));
                    save({ services }, "services");
                  }}
                  className="px-2 py-1 rounded-md border border-border bg-background text-sm"
                >
                  {MODE_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={svc.is_lesson}
                    onChange={() => {
                      const services = settings.services.map((s, i) =>
                        i === idx ? { ...s, is_lesson: !s.is_lesson } : s
                      );
                      setSettings((s) => ({ ...s, services }));
                      save({ services }, "services");
                    }}
                    className="rounded border-border"
                  />
                  Lesson
                </label>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              const services = [
                ...settings.services,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  duration_minutes: 60,
                  price: null,
                  active: true,
                  instructor: null,
                  mode: "both" as const,
                  is_lesson: true,
                },
              ];
              setSettings((s) => ({ ...s, services }));
            }}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add service
          </button>

          <div className="pt-3 border-t border-border space-y-2">
            <label className="text-xs text-muted-foreground block">Age policy</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={99}
                value={settings.age_policy.minimum_age}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    age_policy: { ...s.age_policy, minimum_age: parseInt(e.target.value) || 0 },
                  }))
                }
                onBlur={() => save({ age_policy: settings.age_policy }, "services")}
                className="w-20 px-2 py-1 rounded-md border border-border bg-background text-sm"
              />
              <span className="text-sm text-muted-foreground">minimum age</span>
              <label className="flex items-center gap-1 text-sm ml-4">
                <input
                  type="radio"
                  name="age_mode"
                  checked={settings.age_policy.mode === "soft"}
                  onChange={() => {
                    const age_policy = { ...settings.age_policy, mode: "soft" as const };
                    setSettings((s) => ({ ...s, age_policy }));
                    save({ age_policy }, "services");
                  }}
                />
                Soft (younger OK if focused)
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="age_mode"
                  checked={settings.age_policy.mode === "hard"}
                  onChange={() => {
                    const age_policy = { ...settings.age_policy, mode: "hard" as const };
                    setSettings((s) => ({ ...s, age_policy }));
                    save({ age_policy }, "services");
                  }}
                />
                Hard floor
              </label>
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 5 — Rentals                                          */}
      {/* ============================================================ */}
      <SettingsSection title="Rentals" saved={savedSections["rentals"]}>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.rentals.short_term.enabled}
              onChange={() => {
                const rentals = {
                  ...settings.rentals,
                  short_term: {
                    ...settings.rentals.short_term,
                    enabled: !settings.rentals.short_term.enabled,
                  },
                };
                setSettings((s) => ({ ...s, rentals }));
                save({ rentals }, "rentals");
              }}
            />
            Short-term rental
          </label>
          {settings.rentals.short_term.enabled && (
            <div className="ml-6 flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">$</span>
              <input
                type="number"
                min={0}
                value={settings.rentals.short_term.day_rate}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    rentals: {
                      ...s.rentals,
                      short_term: { ...s.rentals.short_term, day_rate: parseInt(e.target.value) || 0 },
                    },
                  }))
                }
                onBlur={() => save({ rentals: settings.rentals }, "rentals")}
                className="w-20 px-2 py-1 rounded-md border border-border bg-background"
              />
              <span className="text-muted-foreground">per day, $</span>
              <input
                type="number"
                min={0}
                value={settings.rentals.short_term.deposit}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    rentals: {
                      ...s.rentals,
                      short_term: { ...s.rentals.short_term, deposit: parseInt(e.target.value) || 0 },
                    },
                  }))
                }
                onBlur={() => save({ rentals: settings.rentals }, "rentals")}
                className="w-24 px-2 py-1 rounded-md border border-border bg-background"
              />
              <span className="text-muted-foreground">deposit</span>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.rentals.monthly_student.enabled}
              onChange={() => {
                const rentals = {
                  ...settings.rentals,
                  monthly_student: {
                    ...settings.rentals.monthly_student,
                    enabled: !settings.rentals.monthly_student.enabled,
                  },
                };
                setSettings((s) => ({ ...s, rentals }));
                save({ rentals }, "rentals");
              }}
            />
            Monthly student rental
          </label>
          {settings.rentals.monthly_student.enabled && (
            <div className="ml-6 flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">$</span>
              <input
                type="number"
                min={0}
                value={settings.rentals.monthly_student.rate}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    rentals: {
                      ...s.rentals,
                      monthly_student: {
                        ...s.rentals.monthly_student,
                        rate: parseInt(e.target.value) || 0,
                      },
                    },
                  }))
                }
                onBlur={() => save({ rentals: settings.rentals }, "rentals")}
                className="w-24 px-2 py-1 rounded-md border border-border bg-background"
              />
              <span className="text-muted-foreground">per month</span>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 6 — Policies                                         */}
      {/* ============================================================ */}
      <SettingsSection title="Policies" saved={savedSections["policies"]}>
        <div className="space-y-4">
          <div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={settings.cancellation_policy.enabled}
                onChange={() => {
                  const cancellation_policy = {
                    ...settings.cancellation_policy,
                    enabled: !settings.cancellation_policy.enabled,
                  };
                  setSettings((s) => ({ ...s, cancellation_policy }));
                  save({ cancellation_policy }, "policies");
                }}
              />
              Cancellation policy
            </label>
            {settings.cancellation_policy.enabled && (
              <div className="ml-6 mt-2 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={settings.cancellation_policy.hours_before}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        cancellation_policy: {
                          ...s.cancellation_policy,
                          hours_before: parseInt(e.target.value) || 0,
                        },
                      }))
                    }
                    onBlur={() => save({ cancellation_policy: settings.cancellation_policy }, "policies")}
                    className="w-20 px-2 py-1 rounded-md border border-border bg-background"
                  />
                  <span className="text-muted-foreground">hours before, charge</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={settings.cancellation_policy.percent_charge}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        cancellation_policy: {
                          ...s.cancellation_policy,
                          percent_charge: parseInt(e.target.value) || 0,
                        },
                      }))
                    }
                    onBlur={() => save({ cancellation_policy: settings.cancellation_policy }, "policies")}
                    className="w-20 px-2 py-1 rounded-md border border-border bg-background"
                  />
                  <span className="text-muted-foreground">%</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">Mention when:</span>
                  {MENTION_WHEN_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="mention_when"
                        checked={settings.cancellation_policy.mention_when === opt.value}
                        onChange={() => {
                          const cancellation_policy = {
                            ...settings.cancellation_policy,
                            mention_when: opt.value as
                              | "asked_only"
                              | "proactive"
                              | "never",
                          };
                          setSettings((s) => ({ ...s, cancellation_policy }));
                          save({ cancellation_policy }, "policies");
                        }}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-border">
            <label className="text-sm font-medium block mb-2">Payment portal</label>
            <input
              type="text"
              placeholder="https://portal.example.com (optional, used in SMS only)"
              value={settings.payment_portal.url ?? ""}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  payment_portal: { ...s.payment_portal, url: e.target.value || null },
                }))
              }
              onBlur={() => save({ payment_portal: settings.payment_portal }, "policies")}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm mb-2"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.payment_portal.mention_autopay}
                onChange={() => {
                  const payment_portal = {
                    ...settings.payment_portal,
                    mention_autopay: !settings.payment_portal.mention_autopay,
                  };
                  setSettings((s) => ({ ...s, payment_portal }));
                  save({ payment_portal }, "policies");
                }}
              />
              Mention autopay to callers
            </label>
          </div>

          <div className="pt-3 border-t border-border">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={settings.escalation.live_person_callback}
                onChange={() => {
                  const escalation = {
                    ...settings.escalation,
                    live_person_callback: !settings.escalation.live_person_callback,
                  };
                  setSettings((s) => ({ ...s, escalation }));
                  save({ escalation }, "policies");
                }}
              />
              Offer live-person callback
            </label>
            {settings.escalation.live_person_callback && (
              <div className="ml-6 mt-2 flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Follow up</span>
                <input
                  type="text"
                  value={settings.escalation.callback_sla_text}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      escalation: { ...s.escalation, callback_sla_text: e.target.value },
                    }))
                  }
                  onBlur={() => save({ escalation: settings.escalation }, "policies")}
                  placeholder="shortly"
                  className="flex-1 px-2 py-1 rounded-md border border-border bg-background"
                />
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* ============================================================ */}
      {/* Section 7 — Special situations (talent on tour)              */}
      {/* ============================================================ */}
      <SettingsSection
        title="Visiting & away instructors"
        description="Instructors who only teach part of the year, or only remotely."
        saved={savedSections["talent"]}
      >
        <div className="space-y-3">
          {settings.talent_on_tour.instructors.map((entry, idx) => (
            <div key={idx} className="space-y-2 p-3 rounded-lg border border-border">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Instructor name"
                  value={entry.instructor_name}
                  onChange={(e) => {
                    const instructors = settings.talent_on_tour.instructors.map((x, i) =>
                      i === idx ? { ...x, instructor_name: e.target.value } : x
                    );
                    setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
                  }}
                  onBlur={() => save({ talent_on_tour: settings.talent_on_tour }, "talent")}
                  className="flex-1 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
                <select
                  value={entry.status}
                  onChange={(e) => {
                    const status = e.target.value as "available" | "visiting" | "away";
                    const instructors = settings.talent_on_tour.instructors.map((x, i) =>
                      i === idx ? { ...x, status } : x
                    );
                    setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
                    save({ talent_on_tour: { instructors } }, "talent");
                  }}
                  className="px-2 py-1 rounded-md border border-border bg-background text-sm"
                >
                  {TALENT_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const instructors = settings.talent_on_tour.instructors.filter(
                      (_, i) => i !== idx
                    );
                    setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
                    save({ talent_on_tour: { instructors } }, "talent");
                  }}
                  className="text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <textarea
                placeholder="Description (e.g. 'a visiting tabla maestro who teaches in person twice a year and remotely year-round')"
                value={entry.description}
                onChange={(e) => {
                  const instructors = settings.talent_on_tour.instructors.map((x, i) =>
                    i === idx ? { ...x, description: e.target.value } : x
                  );
                  setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
                }}
                onBlur={() => save({ talent_on_tour: settings.talent_on_tour }, "talent")}
                rows={2}
                className="w-full px-2 py-1 rounded-md border border-border bg-background text-sm"
              />
              <select
                value={entry.route_to}
                onChange={(e) => {
                  const route_to = e.target.value as
                    | "start_with_other_instructor"
                    | "callback_only"
                    | "remote_only";
                  const instructors = settings.talent_on_tour.instructors.map((x, i) =>
                    i === idx ? { ...x, route_to } : x
                  );
                  setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
                  save({ talent_on_tour: { instructors } }, "talent");
                }}
                className="w-full px-2 py-1 rounded-md border border-border bg-background text-sm"
              >
                {TALENT_ROUTE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <button
            onClick={() => {
              const instructors = [
                ...settings.talent_on_tour.instructors,
                {
                  instructor_name: "",
                  status: "visiting" as const,
                  description: "",
                  route_to: "callback_only" as const,
                },
              ];
              setSettings((s) => ({ ...s, talent_on_tour: { instructors } }));
            }}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add instructor
          </button>
        </div>
      </SettingsSection>
    </main>
  );
}
