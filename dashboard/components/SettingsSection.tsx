"use client";

import { useState, useCallback } from "react";
import { Check } from "lucide-react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  onSave?: () => void;
}

export function SettingsSection({ title, description, children, onSave }: SettingsSectionProps) {
  const [saved, setSaved] = useState(false);

  const showSaved = useCallback(() => {
    setSaved(true);
    onSave?.();
    setTimeout(() => setSaved(false), 1500);
  }, [onSave]);

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          )}
        </div>
        {saved && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 transition-opacity duration-300">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
      </div>
      <div onBlur={showSaved}>{children}</div>
    </div>
  );
}
