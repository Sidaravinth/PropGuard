/** What the grounding gate accepts and rejects. */
import { describe, expect, it } from "vitest";
import { figure, type Figure } from "../src/agent/evidence.js";
import { checkGrounding, describeGroundingFailure, findRawFigures, type Identifiers } from "../src/agent/grounding.js";

const src = { kind: "policy_constant", name: "X" } as const;
const f = (key: string, unit: Figure["unit"], value: number | string) => figure(key, key, unit, value, [], src);
const figures: Figure[] = [
  f("work_order", "cents", 90_000),
  f("technician_quote", "cents", 115_000),
  f("unpaid_balance", "cents", 315_000),
  f("quote_tolerance_percent", "percent", 10),
  f("renewal_window_days", "days", 60),
  f("term_months", "months", 12),
  f("lease_end", "date", "2027-01-15"),
  f("paid_on_time_months", "count", 5),
  f("months_on_record", "count", 6),
];
const ids: Identifiers = {
  unitNumbers: ["201"],
  propertyNames: ["Riverside Lofts"],
  ticketIds: [3],
  leaseIds: [4],
  evaluationIds: [21],
  sections: ["5.2", "4"],
  months: ["2026-10", "2026-11"],
};
const check = (text: string) => checkGrounding({ summary: text }, figures, () => true, ids);

describe("rejected: numbers that do not come from a figure", () => {
  it.each([
    // every string the first audit got past the old check
    "Rent will be 1,975 per month.",
    "The repair costs 5000 dollars.",
    "Give forty days notice.",
    "A twenty percent increase applies.",
    "They owe nine hundred and fifty dollars.",
    "Pay €500 now.",
    "Cost is USD5,200.",
    "Fee of $99.",
    // more forms
    "The total is 1500.",
    "Charge them 480.",
    "A fee of five thousand dollars applies.",
    "Sixty-five days remain.",
    "Respond within 45 calendar days.",
    "Respond within forty-five (45) days.",
    "It costs 500 EUR.",
    "It costs two hundred pounds.",
    "About $5k in total.",
    "About $1.2 million in total.",
    "A 900-dollar repair plus a 250 dollar fee.",
    "Payment is due on March 3.",
    "Payment is due on the 3rd of March.",
    "Payment is due on 3 March 2027.",
    "Arrears date back to May 2024.",
    "The lease dates from 2019.",
    "Call within 24 hours.",
    "They paid 4 of 6 months.",
    "Unit 999 is affected.",
    "Ticket #12 is related.",
    "See Section 9.9.",
    "The unit is 201 dollars short.",
    "An extra 201 is due.",
  ])("%s", (text) => {
    expect(check(text).passed, JSON.stringify(check(text).ungrounded_figures)).toBe(false);
  });
});

describe("accepted: figures that match, record identifiers and ordinary prose", () => {
  it.each([
    "The work order is $900.00 and the quote is $1,150.00.",
    "The quote is 1,150 dollars against nine hundred dollars.",
    "The balance is USD 3150.",
    "The limit is 10% (ten percent).",
    "The window is sixty (60) days, or 60 days.",
    "A twelve-month term, also written 12-month.",
    "The lease ends on January 15, 2027, that is 15 January 2027 or 2027-01-15.",
    "The lease ends January 15.",
    "Rent for October 2026 and November 2026 is outstanding; the lease ends in January 2027.",
    "The 3-way check flagged Ticket #3 for Unit 201 under Section 5.2.",
    "Riverside Lofts 201, lease 4, evaluation 21, Clause 4.",
    "Option 1 or option 2 may be chosen; see #3.",
    "5 of 6 months were paid on time.",
    "The tenant paid 5 months on time out of 6 ledger months.",
    "1. Review the quote.\n2. Contact the technician.",
    "We may ask for one revised quote. There are two options.",
    "The tenant may 'dispute' the charge.",
  ])("%s", (text) => {
    const r = check(text);
    expect(r.passed, JSON.stringify(r.ungrounded_figures)).toBe(true);
  });
});

describe("internal record ids", () => {
  it.each(["Repair at unit:U101 is pending.", "See lease:4:field:monthly_rent.", "Entry ledger:45 is unpaid.", "Policy evaluation:21 flagged it."])("are rejected in prose: %s", (text) => {
    const r = check(text);
    expect(r.passed).toBe(false);
    expect(r.internal_ids_in_text).toHaveLength(1);
  });

  it("the option code written in prose is reported as a code, not as a stray number", () => {
    const r = check("We recommend the twelve_month_3pct option.");
    expect(r.internal_ids_in_text.map((u) => u.text)).toEqual(["twelve_month_3pct"]);
    expect(r.ungrounded_figures).toEqual([]);
    expect(describeGroundingFailure(r)).toMatch(/internal option code.*in words/);
    expect(checkGrounding({ option_key: "twelve_month_3pct", key: "twelve_month_3pct" }, figures, () => true, ids).passed).toBe(true);
  });

  it("are fine in evidence_ids", () => {
    expect(checkGrounding({ evidence_ids: ["unit:U101", "lease:4"] }, figures, () => true, ids).passed).toBe(true);
  });
});

describe("known limit", () => {
  it("a correct value under the wrong label is accepted", () => {
    expect(check("The balance is $1,150.00 for the work order.").passed).toBe(true);
  });
});

describe("findRawFigures", () => {
  it("reports each number once, with its value in the stored unit", () => {
    expect(findRawFigures("Nine hundred dollars within sixty (60) days, 5000 dollars after 2 weeks").map((x) => [x.kind, x.value])).toEqual([
      ["money", 90_000],
      ["money", 500_000],
      ["days", 60],
      ["days", 14],
    ]);
  });
});
