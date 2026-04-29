import { Phone, CalendarCheck, PhoneMissed } from "lucide-react";

interface StatsStripProps {
  calls: number;
  bookings: number;
  missed: number;
}

export function StatsStrip({ calls, bookings, missed }: StatsStripProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard
        icon={<Phone className="h-4 w-4" />}
        label="Today's Calls"
        value={calls}
      />
      <StatCard
        icon={<CalendarCheck className="h-4 w-4" />}
        label="Booked"
        value={bookings}
      />
      <StatCard
        icon={<PhoneMissed className="h-4 w-4" />}
        label="Missed"
        value={missed}
      />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 text-center">
      <div className="flex justify-center text-muted-foreground">{icon}</div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
