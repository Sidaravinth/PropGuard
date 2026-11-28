import { formatCents } from "../lib/format";

export interface ChargeNotice {
  proposed_charge_cents: number;
  deductible_share_cents: number;
  difference_cents: number;
}

/** Shown wherever a manager reads or approves a charge that is above the lease deductible share. */
export function ChargeWarning({ notice }: { notice: ChargeNotice | null | undefined }) {
  if (!notice) return null;
  return (
    <div className="alert alert-error charge-warning" role="alert">
      <strong>Tenant charge is above the deductible share.</strong> Proposed charge <strong>{formatCents(notice.proposed_charge_cents)}</strong>, tenant share under the lease
      repair deductible {formatCents(notice.deductible_share_cents)}: {formatCents(notice.difference_cents)} more. Approving spend reserves the full{" "}
      {formatCents(notice.proposed_charge_cents)} against the security deposit.
    </div>
  );
}
