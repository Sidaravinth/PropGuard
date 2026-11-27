/**
 * Role-based permissions. This file is the single source of truth for what each role may do; the
 * backend checks it on every protected route (the frontend only uses it to hide controls).
 *
 * The only difference between the roles is approval authority, which follows the repair-cost
 * hierarchy. The required tier always comes from the deterministic policy engine's evaluation
 * (repair cost, escalated by exceptions); no user can choose or change it.
 *
 *   ≤ $200, no exceptions      AUTO_APPROVE        (exceptions raise it to PROPERTY_MANAGER)
 *   > $200 and ≤ $1,000        PROPERTY_MANAGER
 *   > $1,000                   REGIONAL_DIRECTOR
 */
import type { ApprovalTier } from "../policy/policyEngine.js";

export const ROLES = ["property_manager", "regional_director"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  property_manager: "Property Manager",
  regional_director: "Regional Director",
};

export type Permission =
  | "records.read" // view units, tenants, leases, ledgers, tickets, briefs, audit trail
  | "records.write" // create/edit operational records, upload documents, correct extractions
  | "policy.run" // run the deterministic policy check (read-only verification; records an evaluation)
  | "briefs.generate"; // ask the AI agent to draft a Decision Brief

const ALL_PERMISSIONS: readonly Permission[] = ["records.read", "records.write", "policy.run", "briefs.generate"];

/** Both roles have the same operational permissions; only approval authority differs. */
const GRANTS: Record<Role, readonly Permission[]> = {
  property_manager: ALL_PERMISSIONS,
  regional_director: ALL_PERMISSIONS,
};

/** Approval hierarchy: each role may sign off its own tier and the tiers below it. */
const APPROVAL_TIERS: Record<Role, readonly ApprovalTier[]> = {
  property_manager: ["AUTO_APPROVE", "PROPERTY_MANAGER"],
  regional_director: ["AUTO_APPROVE", "PROPERTY_MANAGER", "REGIONAL_DIRECTOR"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

export function canApproveTier(role: Role, tier: ApprovalTier): boolean {
  return APPROVAL_TIERS[role].includes(tier);
}

export function permissionsFor(role: Role) {
  return { permissions: [...GRANTS[role]], approvalTiers: [...APPROVAL_TIERS[role]] };
}
