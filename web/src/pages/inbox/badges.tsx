const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  revision_requested: { label: "Revision requested", tone: "info" },
  superseded: { label: "Superseded", tone: "" },
};

export function BriefStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "" };
  return <span className={`badge badge-${s.tone}`}>{s.label}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const tone = priority === "high" ? "danger" : priority === "medium" ? "warning" : "";
  return <span className={`badge badge-${tone}`}>{priority[0]!.toUpperCase() + priority.slice(1)}</span>;
}

export function BriefTypeBadge({ type }: { type: string }) {
  return <span className={`badge ${type === "renewal" ? "badge-info" : "badge-purple"}`}>{type === "renewal" ? "Renewal" : "Maintenance"}</span>;
}
