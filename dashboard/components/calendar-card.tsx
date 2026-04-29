"use client";

import { useState } from "react";
import { Calendar, Check, X, Loader2 } from "lucide-react";

interface CalendarCardProps {
  shopId: string;
  integration: {
    status: string;
    provider_account_email: string | null;
    updated_at: string | null;
  } | null;
}

export function CalendarCard({ integration }: CalendarCardProps) {
  const [loading, setLoading] = useState(false);
  const isConnected = integration?.status === "connected";

  async function handleConnect() {
    setLoading(true);
    try {
      const res = await fetch("/api/calendar/connect", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Calendar className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">Google Calendar</h2>
          <p className="text-sm text-muted-foreground">
            {isConnected
              ? `Connected to ${integration?.provider_account_email}`
              : "Not connected"}
          </p>
        </div>
      </div>

      <div className="mt-4">
        {isConnected ? (
          <div className="flex items-center gap-2 text-sm text-green-700">
            <Check className="h-4 w-4" />
            <span>Calendar sync active</span>
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calendar className="h-4 w-4" />
            )}
            Connect Google Calendar
          </button>
        )}
      </div>
    </div>
  );
}
