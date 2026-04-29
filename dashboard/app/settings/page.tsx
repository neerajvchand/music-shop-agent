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

      {/* Greeting */}
      <SettingsSection
        title="Greeting"
        description="What the agent says when answering the phone."
        saved={savedSections["greeting"]}
      >
        <input
          type="text"
          maxLength={200}
          value={settings.greeting}
          onChange={(e) =>
            setSettings((s) => ({ ...s, greeting: e.target.value }))
          }
          onBlur={() => save({ greeting: settings.greeting }, "greeting")}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {settings.greeting.length}/200
        </p>
      </SettingsSection>

      {/* Voice */}
      <SettingsSection title="Voice Persona" description="How the agent sounds." saved={savedSections["voice"]}>
        <select
          value={settings.voice_id}
          onChange={(e) => {
            const voice_id = e.target.value;
            setSettings((s) => ({ ...s, voice_id }));
            save({ voice_id }, "voice");
          }}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {VOICE_OPTIONS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </SettingsSection>

      {/* Business Hours */}
      <SettingsSection title="Business Hours" saved={savedSections["hours"]}>
        <div className="space-y-3">
          {DAYS.map((day) => {
            const hours = settings.business_hours[day];
            const closed = hours === null;
            return (
              <div
                key={day}
                className="flex items-center gap-3"
              >
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
        </div>
      </SettingsSection>

      {/* Services */}
      <SettingsSection
        title="Services"
        description="What the agent can book."
        saved={savedSections["services"]}
      >
        <div className="space-y-3">
          {settings.services.map((svc, idx) => (
            <div
              key={svc.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border"
            >
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
                className="text-muted-foreground hover:text-red-600 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
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
                  active: true,
                },
              ];
              setSettings((s) => ({ ...s, services }));
            }}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add service
          </button>
        </div>
      </SettingsSection>

      {/* Booking Buffer */}
      <SettingsSection
        title="Booking Buffer"
        description="Minutes between appointments."
        saved={savedSections["buffer"]}
      >
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
              save({ booking_buffer_minutes: settings.booking_buffer_minutes }, "buffer")
            }
            className="flex-1"
          />
          <span className="text-sm font-medium w-16 text-right">
            {settings.booking_buffer_minutes} min
          </span>
        </div>
      </SettingsSection>

      {/* Off-Hours Behavior */}
      <SettingsSection
        title="Off-Hours Behavior"
        description="What the agent does when the shop is closed."
        saved={savedSections["off_hours"]}
      >
        <div className="space-y-2">
          {OFF_HOURS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-muted transition-colors"
            >
              <input
                type="radio"
                name="off_hours"
                value={opt.value}
                checked={settings.off_hours_behavior === opt.value}
                onChange={() => {
                  setSettings((s) => ({
                    ...s,
                    off_hours_behavior: opt.value as ShopSettings["off_hours_behavior"],
                  }));
                  save({ off_hours_behavior: opt.value as ShopSettings["off_hours_behavior"] }, "off_hours");
                }}
                className="rounded-full border-border"
              />
              <span className="text-sm">{opt.label}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
    </main>
  );
}
