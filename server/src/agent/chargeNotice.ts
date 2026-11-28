/**
 * A ticket's proposed tenant charge can be higher than the tenant's share under the lease repair deductible
 * (for example accidental damage). That is allowed by the policy engine; it must never be hidden. These are
 * read-only statements about an existing policy result: they change no verdict, tier or approval.
 */
import { formatUsd, type PolicyResult } from "../policy/policyEngine.js";

export interface ChargeDiscrepancy {
  proposed_charge_cents: number;
  deductible_share_cents: number;
  difference_cents: number;
}

/** The discrepancy in a policy result, or null when there is no charge, no known share, or no excess. */
export function chargeDiscrepancy(result: Pick<PolicyResult, "threeWay" | "depositCap"> | null | undefined): ChargeDiscrepancy | null {
  const charge = result?.depositCap.proposedChargeCents ?? null;
  const share = result?.threeWay.tenantShareCents ?? null;
  if (charge === null || share === null || charge <= share) return null;
  return { proposed_charge_cents: charge, deductible_share_cents: share, difference_cents: charge - share };
}

/**
 * The line code puts on every message TO A TENANT: the amount actually reserved by this decision.
 * reservedCents is null when the decision reserved nothing.
 */
export function tenantChargeLine(reservedCents: number | null, discrepancy: ChargeDiscrepancy | null): string {
  if (reservedCents === null) return "Tenant charge: no amount has been reserved against your security deposit.";
  const line = `Tenant charge: ${formatUsd(reservedCents)} has been reserved against your security deposit.`;
  return discrepancy
    ? `${line} This is ${formatUsd(discrepancy.difference_cents)} more than your ${formatUsd(discrepancy.deductible_share_cents)} share under the lease repair deductible.`
    : line;
}
