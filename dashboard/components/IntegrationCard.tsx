"use client";

import { useState } from "react";
import { Calendar, AlertCircle, Unlink, Loader2 } from "lucide-react";

interface IntegrationCardProps {
  provider: string;
  name: string;
  status: "connected" | "needs_attention" | "disconnected";
  accountEmail?: string | null;
}

export function IntegrationCard({
  provider,
  name,
  status,
  accountEmail,
}: IntegrationCardProps) {
  const [loading, setLoading] = useState(false);

  async function handleConnect() {
    setLoading(true);
    try {
      const res = await fetch(`/api/integrations/${provider}/connect`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    try {
      await fetch(`/api/integrations/${provider}/disconnect`, {
        method: "POST",
      });
      window.location.reload();
    } catch {
      setLoading(false);
    }
  }

  const statusConfig = {
    connected: {
      icon: Calendar,
      text: accountEmail ? `Connected as ${accountEmail}` : "Connected",
      button: (
        <button
          onClick={handleDisconnect}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
          Disconnect
        </button>
      ),
    },
    needs_attention: {
      icon: AlertCircle,
      text: "Needs attention: reconnect to restore access",
      button: (
        <button
          onClick={handleConnect}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
          Reconnect
        </button>
      ),
    },
    disconnected: {
      icon: Calendar,
      text: "Not connected",
      button: (
        <button
          onClick={handleConnect}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
          Connect {name}
        </button>
      ),
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-muted p-3">
          <Icon className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold">{name}</h3>
          <p className="text-sm text-muted-foreground mt-1">{config.text}</p>
          <div className="mt-4">{config.button}</div>
        </div>
      </div>
    </div>
  );
}
