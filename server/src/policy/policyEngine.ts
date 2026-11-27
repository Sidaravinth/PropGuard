/**
 * PropGuard deterministic policy engine.
 *
 * HARD RULES FOR THIS MODULE
 *  - Pure functions only: no I/O, no database, no network, no clock.
 *  - No AI/LLM imports, ever (enforced by tests/boundaries.test.ts).
 *  - All money is integer cents. No floating-point arithmetic is used for any decision.
 *  - Inputs are numeric facts only. Free text (ticket descriptions, notes) is never accepted,
 *    so instructions hidden in text cannot influence a verdict.
 */

export const ENGINE_VERSION = "1.0.0";

export const POLICY = {
  /** Repair cost <= this is eligible for auto-approval (if there are no exceptions). */
  AUTO_APPROVE_MAX_CENTS: 20_000, // $200.00
  /** Repair cost <= this (and > auto max) needs a Property Manager. Above it: Regional Director. */
  PROPERTY_MANAGER_MAX_CENTS: 100_000, // $1,000.00
  /** Technician quote may exceed the work order by at most this percentage. */
  QUOTE_TOLERANCE_PERCENT: 10,
} as const;

export type ApprovalTier = "AUTO_APPROVE" | "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";

export type ExceptionCode =
  | "QUOTE_EXCEEDS_WORK_ORDER"
  | "UNPAID_BALANCE"
  | "LEASE_NOT_FOUND"
  | "DEDUCTIBLE_UNKNOWN"
  | "DEPOSIT_CAP_EXCEEDED"
  | "DEPOSIT_UNKNOWN";

export interface PolicyException {
  code: ExceptionCode;
  message: string;
  values: Record<string, number | null>;
}

export interface RuleTraceEntry {
  rule: string;
  passed: boolean;
  detail: string;
}

export class PolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyInputError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertCents(name: string, v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new PolicyInputError(`${name} must be a non-negative integer number of cents (got ${String(v)})`);
  }
}

function assertOptionalCents(name: string, v: unknown): asserts v is number | null {
  if (v !== null) assertCents(name, v);
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Rule 1 — 3-way maintenance verification (work order vs quote vs lease deductible)
// ---------------------------------------------------------------------------

export interface ThreeWayInput {
  workOrderCents: number;
  quoteCents: number;
  /** Repair deductible from the lease; null when the lease has no (verified) deductible. */
  deductibleCents: number | null;
  /** Outstanding rent owed by the tenant (sum of unpaid ledger amounts). */
  unpaidBalanceCents: number;
}

export interface ThreeWayResult {
  /** Cost used for all thresholds: the higher of work order and quote. */
  costBasisCents: number;
  /** quote - work order (may be negative). Informational. */
  quoteDeltaCents: number;
  /** Informational display value only (2 dp); decisions use the integer comparison below. */
  quoteVariancePercent: number | null;
  quoteWithinTolerance: boolean;
  /** Portion the tenant pays under the lease deductible: min(cost, deductible). Null if deductible unknown. */
  tenantShareCents: number | null;
  ownerShareCents: number | null;
  exceptions: PolicyException[];
  trace: RuleTraceEntry[];
}

export function threeWayCheck(input: ThreeWayInput): ThreeWayResult {
  assertCents("workOrderCents", input.workOrderCents);
  assertCents("quoteCents", input.quoteCents);
  assertOptionalCents("deductibleCents", input.deductibleCents);
  assertCents("unpaidBalanceCents", input.unpaidBalanceCents);

  const { workOrderCents: wo, quoteCents: quote, deductibleCents, unpaidBalanceCents } = input;
  const exceptions: PolicyException[] = [];
  const trace: RuleTraceEntry[] = [];

  // quote > wo * 1.10  <=>  quote * 100 > wo * (100 + tolerance)   (exact integer math)
  const quoteWithinTolerance = quote * 100 <= wo * (100 + POLICY.QUOTE_TOLERANCE_PERCENT);
  const quoteVariancePercent = wo === 0 ? null : Math.round(((quote - wo) * 10_000) / wo) / 100;

  trace.push({
    rule: "QUOTE_TOLERANCE",
    passed: quoteWithinTolerance,
    detail:
      `Quote ${formatUsd(quote)} vs work order ${formatUsd(wo)}` +
      (quoteVariancePercent === null ? " (work order is $0)" : ` (${quoteVariancePercent >= 0 ? "+" : ""}${quoteVariancePercent}%)`) +
      `; limit +${POLICY.QUOTE_TOLERANCE_PERCENT}%`,
  });
  if (!quoteWithinTolerance) {
    exceptions.push({
      code: "QUOTE_EXCEEDS_WORK_ORDER",
      message: `Technician quote ${formatUsd(quote)} exceeds work order ${formatUsd(wo)} by more than ${POLICY.QUOTE_TOLERANCE_PERCENT}%.`,
      values: { workOrderCents: wo, quoteCents: quote, quoteDeltaCents: quote - wo },
    });
  }

  const hasUnpaid = unpaidBalanceCents > 0;
  trace.push({
    rule: "TENANT_LEDGER_CLEAR",
    passed: !hasUnpaid,
    detail: hasUnpaid ? `Tenant has unpaid balance of ${formatUsd(unpaidBalanceCents)}` : "No unpaid ledger balance",
  });
  if (hasUnpaid) {
    exceptions.push({
      code: "UNPAID_BALANCE",
      message: `Tenant has an unpaid ledger balance of ${formatUsd(unpaidBalanceCents)}.`,
      values: { unpaidBalanceCents },
    });
  }

  const costBasisCents = Math.max(wo, quote);
  const tenantShareCents = deductibleCents === null ? null : Math.min(costBasisCents, deductibleCents);
  const ownerShareCents = tenantShareCents === null ? null : costBasisCents - tenantShareCents;
  trace.push({
    rule: "LEASE_DEDUCTIBLE_SPLIT",
    passed: deductibleCents !== null,
    detail:
      deductibleCents === null
        ? "Repair deductible unknown — cost split cannot be computed"
        : `Deductible ${formatUsd(deductibleCents)}: tenant ${formatUsd(tenantShareCents!)}, owner ${formatUsd(ownerShareCents!)}`,
  });

  return {
    costBasisCents,
    quoteDeltaCents: quote - wo,
    quoteVariancePercent,
    quoteWithinTolerance,
    tenantShareCents,
    ownerShareCents,
    exceptions,
    trace,
  };
}

// ---------------------------------------------------------------------------
// Rule 2 — Approval threshold gating
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  /** Tier implied by cost alone. */
  baseTier: ApprovalTier;
  /** Final tier after exceptions are considered. Exceptions can only ever RAISE the tier. */
  tier: ApprovalTier;
  autoApproveEligible: boolean;
  trace: RuleTraceEntry;
}

export function approvalTier(costCents: number, exceptionCount: number): ApprovalResult {
  assertCents("costCents", costCents);
  if (!Number.isSafeInteger(exceptionCount) || exceptionCount < 0) {
    throw new PolicyInputError("exceptionCount must be a non-negative integer");
  }

  const baseTier: ApprovalTier =
    costCents <= POLICY.AUTO_APPROVE_MAX_CENTS
      ? "AUTO_APPROVE"
      : costCents <= POLICY.PROPERTY_MANAGER_MAX_CENTS
        ? "PROPERTY_MANAGER"
        : "REGIONAL_DIRECTOR";

  const tier: ApprovalTier = baseTier === "AUTO_APPROVE" && exceptionCount > 0 ? "PROPERTY_MANAGER" : baseTier;
  const autoApproveEligible = tier === "AUTO_APPROVE";

  const band =
    baseTier === "AUTO_APPROVE"
      ? `<= ${formatUsd(POLICY.AUTO_APPROVE_MAX_CENTS)}`
      : baseTier === "PROPERTY_MANAGER"
        ? `> ${formatUsd(POLICY.AUTO_APPROVE_MAX_CENTS)} and <= ${formatUsd(POLICY.PROPERTY_MANAGER_MAX_CENTS)}`
        : `> ${formatUsd(POLICY.PROPERTY_MANAGER_MAX_CENTS)}`;

  return {
    baseTier,
    tier,
    autoApproveEligible,
    trace: {
      rule: "APPROVAL_THRESHOLD",
      passed: autoApproveEligible,
      detail:
        `Cost ${formatUsd(costCents)} is ${band} → ${baseTier}` +
        (tier !== baseTier ? `; raised to ${tier} because of ${exceptionCount} exception(s)` : ""),
    },
  };
}

// ---------------------------------------------------------------------------
// Rule 3 — Security deposit cap
// ---------------------------------------------------------------------------

export interface DepositCapResult {
  /** False when no tenant charge is proposed (rule not applicable). */
  applicable: boolean;
  allowed: boolean;
  proposedChargeCents: number | null;
  remainingDepositCents: number | null;
  /** Largest charge the rule permits (0 if the deposit is unknown). */
  maxAllowedChargeCents: number | null;
  exception: PolicyException | null;
  trace: RuleTraceEntry;
}

export function depositCapCheck(proposedChargeCents: number | null, remainingDepositCents: number | null): DepositCapResult {
  assertOptionalCents("proposedChargeCents", proposedChargeCents);
  assertOptionalCents("remainingDepositCents", remainingDepositCents);

  if (proposedChargeCents === null) {
    return {
      applicable: false,
      allowed: true,
      proposedChargeCents,
      remainingDepositCents,
      maxAllowedChargeCents: remainingDepositCents,
      exception: null,
      trace: { rule: "DEPOSIT_CAP", passed: true, detail: "No tenant charge proposed — rule not applicable" },
    };
  }

  if (remainingDepositCents === null) {
    // No deposit on record: we cannot verify the cap, so the charge is blocked (fail closed).
    return {
      applicable: true,
      allowed: false,
      proposedChargeCents,
      remainingDepositCents,
      maxAllowedChargeCents: 0,
      exception: {
        code: "DEPOSIT_UNKNOWN",
        message: `Proposed tenant charge ${formatUsd(proposedChargeCents)} cannot be verified: no security deposit is recorded for this lease.`,
        values: { proposedChargeCents, remainingDepositCents: null },
      },
      trace: { rule: "DEPOSIT_CAP", passed: false, detail: "No security deposit on record — charge blocked (fail closed)" },
    };
  }

  const allowed = proposedChargeCents <= remainingDepositCents;
  return {
    applicable: true,
    allowed,
    proposedChargeCents,
    remainingDepositCents,
    maxAllowedChargeCents: remainingDepositCents,
    exception: allowed
      ? null
      : {
          code: "DEPOSIT_CAP_EXCEEDED",
          message: `Proposed tenant charge ${formatUsd(proposedChargeCents)} exceeds remaining security deposit ${formatUsd(remainingDepositCents)}.`,
          values: { proposedChargeCents, remainingDepositCents },
        },
    trace: {
      rule: "DEPOSIT_CAP",
      passed: allowed,
      detail: `Proposed charge ${formatUsd(proposedChargeCents)} vs remaining deposit ${formatUsd(remainingDepositCents)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Composite ticket evaluation
// ---------------------------------------------------------------------------

/** Numeric facts about a ticket, assembled from the database by the caller. */
export interface TicketFacts {
  workOrderCents: number;
  quoteCents: number;
  leaseFound: boolean;
  deductibleCents: number | null;
  unpaidBalanceCents: number;
  remainingDepositCents: number | null;
  proposedTenantChargeCents: number | null;
}

export interface PolicyResult {
  engineVersion: string;
  /** PASS = no exceptions; EXCEPTION = at least one rule flagged. */
  verdict: "PASS" | "EXCEPTION";
  costBasisCents: number;
  approverRequired: ApprovalTier;
  autoApproveEligible: boolean;
  exceptions: PolicyException[];
  threeWay: Omit<ThreeWayResult, "exceptions" | "trace">;
  depositCap: Omit<DepositCapResult, "exception" | "trace">;
  ruleTrace: RuleTraceEntry[];
}

export function evaluateTicket(facts: TicketFacts): PolicyResult {
  const threeWay = threeWayCheck({
    workOrderCents: facts.workOrderCents,
    quoteCents: facts.quoteCents,
    deductibleCents: facts.deductibleCents,
    unpaidBalanceCents: facts.unpaidBalanceCents,
  });
  const exceptions = [...threeWay.exceptions];
  const trace = [...threeWay.trace];

  if (!facts.leaseFound) {
    exceptions.push({
      code: "LEASE_NOT_FOUND",
      message: "No lease on record for this tenant/unit — repair terms cannot be verified.",
      values: {},
    });
  } else if (facts.deductibleCents === null) {
    exceptions.push({
      code: "DEDUCTIBLE_UNKNOWN",
      message: "Lease repair deductible is missing or unverified — cost split needs human review.",
      values: {},
    });
  }

  const deposit = depositCapCheck(facts.proposedTenantChargeCents, facts.remainingDepositCents);
  trace.push(deposit.trace);
  if (deposit.exception) exceptions.push(deposit.exception);

  const approval = approvalTier(threeWay.costBasisCents, exceptions.length);
  trace.push(approval.trace);

  const { exceptions: _e, trace: _t, ...threeWaySummary } = threeWay;
  const { exception: _de, trace: _dt, ...depositSummary } = deposit;

  return {
    engineVersion: ENGINE_VERSION,
    verdict: exceptions.length === 0 ? "PASS" : "EXCEPTION",
    costBasisCents: threeWay.costBasisCents,
    approverRequired: approval.tier,
    autoApproveEligible: approval.autoApproveEligible,
    exceptions,
    threeWay: threeWaySummary,
    depositCap: depositSummary,
    ruleTrace: trace,
  };
}
