import {
  Building2,
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  Settings,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  section: "Overview" | "Operations" | "Decisions" | "Account";
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard, section: "Overview", description: "Portfolio, lease, maintenance and payment overview." },
  { path: "/properties", label: "Properties & Units", icon: Building2, section: "Operations", description: "Properties, units, occupancy and the tenants and leases attached to each unit." },
  { path: "/tenants", label: "Tenants", icon: Users, section: "Operations", description: "Tenant profiles with lease, payment and maintenance history." },
  { path: "/leases", label: "Lease Management", icon: FileText, section: "Operations", description: "Upload lease documents, review AI extraction against its source, and correct fields." },
  { path: "/maintenance", label: "Maintenance", icon: Wrench, section: "Operations", description: "Maintenance tickets, deterministic policy verification and approval requirements." },
  { path: "/payments", label: "Payment Ledger", icon: Wallet, section: "Operations", description: "Rent due, paid and outstanding, with spreadsheet import." },
  { path: "/inbox", label: "Decision Inbox", icon: Inbox, section: "Decisions", description: "AI-drafted Decision Briefs awaiting human review and approval." },
  { path: "/audit", label: "Audit Trail", icon: History, section: "Decisions", description: "Append-only record of every upload, extraction, agent run, policy check and decision." },
];

export const SETTINGS_ITEM: NavItem = {
  path: "/settings",
  label: "Settings",
  icon: Settings,
  section: "Account",
  description: "Your profile, password and active sessions.",
};

export function findNavItem(pathname: string): NavItem | undefined {
  return [...NAV_ITEMS, SETTINGS_ITEM].find((n) => (n.path === "/" ? pathname === "/" : pathname === n.path || pathname.startsWith(`${n.path}/`)));
}
