import { describe, expect, it } from "vitest";
import { checkApprover, checkCashCounter, checkCountPeople, checkDepositor } from "../lib/engine/rules";

describe("checkCountPeople", () => {
  it("needs two different named people", () => {
    expect(checkCountPeople("Marcus Hill", "Priya Shah")).toBeNull();
    expect(checkCountPeople("", "Priya Shah")).toBe("Both the counter and the checker need a name.");
    expect(checkCountPeople("Marcus Hill", "  ")).toBe("Both the counter and the checker need a name.");
    expect(checkCountPeople("Marcus Hill", " marcus hill ")).toBe("A second volunteer has to check the count.");
  });
});

describe("checkCashCounter", () => {
  it("allows the first count by anyone", () => {
    expect(checkCashCounter("Jordan Lee", [])).toBeNull();
  });

  it("needs the next count to be by someone else", () => {
    expect(checkCashCounter("Jordan Lee", [{ countedBy: "Jordan Lee" }])).toBe("The next cash count has to be done by a different volunteer.");
    expect(checkCashCounter("JORDAN LEE", [{ countedBy: "Jordan Lee" }])).not.toBeNull();
    expect(checkCashCounter("Priya Shah", [{ countedBy: "Jordan Lee" }])).toBeNull();
  });

  it("lets a third person recount after a disagreement", () => {
    expect(checkCashCounter("Marcus Hill", [{ countedBy: "Jordan Lee" }, { countedBy: "Priya Shah" }])).toBeNull();
  });

  it("needs a name", () => {
    expect(checkCashCounter(" ", [])).toBe("Enter who counted the cash.");
  });
});

describe("checkDepositor", () => {
  it("keeps the deposit away from anyone who counted the cash", () => {
    const counters = ["Jordan Lee", "Priya Shah"];
    expect(checkDepositor("Dana Reyes", counters)).toBeNull();
    expect(checkDepositor("priya shah", counters)).toBe("The deposit should be made by someone who did not count the cash.");
    expect(checkDepositor("", counters)).toBe("Enter who made the deposit.");
  });
});

describe("checkApprover", () => {
  it("needs someone other than the requester, after the opening count", () => {
    expect(checkApprover("Pat Okafor", "Dana Reyes", true)).toBeNull();
    expect(checkApprover("Dana Reyes", " dana reyes", true)).toBe("Someone other than the requester has to approve.");
    expect(checkApprover("Pat Okafor", "Dana Reyes", false)).toBe("Confirm the opening count first, so the receipt can be checked against it.");
    expect(checkApprover("", "Dana Reyes", true)).toBe("Enter who is approving.");
  });
});
