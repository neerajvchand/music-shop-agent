import { AlertCircle } from "lucide-react";

interface Decision {
  id: string;
  decision_type: string;
  title: string;
  body: string;
  created_at: string;
}

interface DecisionsListProps {
  decisions: Decision[];
}

export function DecisionsList({ decisions }: DecisionsListProps) {
  if (decisions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No decisions needed. You are all caught up.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="font-semibold flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          Decisions Needed
        </h2>
      </div>
      <ul className="divide-y divide-border">
        {decisions.map((d) => (
          <li key={d.id} className="px-6 py-4">
            <p className="text-sm font-medium">{d.title}</p>
            <p className="text-sm text-muted-foreground mt-1">{d.body}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {new Date(d.created_at).toLocaleDateString()}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
