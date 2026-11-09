import { describe, expect, it } from "vitest";
import { checkApprover, checkCashCounter, checkCashCounterNotCloser, checkCountPeople, checkDepositor } from "../lib/engine/rules";

describe("checkCountPeople", () => {
  it("needs two different named people", () => {
    expect(checkCountPeople("Marcus Hill", "Priya Shah")).toBeNull();
    expect(checkCountPeople("", "Priya Shah")).toBe("Both the counter and the checker need a name.");
    expect(checkCountPeople("Marcus Hill", "  ")).toBe("Both the counter and the checker need a name.");
    expect(checkCountPeople("Marcus Hill", " marcus hill ")).toBe("A second volunteer has to check the count.");
  });

  it("is not fooled by extra spaces or invisible characters", () => {
    expect(checkCountPeople("Marcus Hill", "Marcus  Hill")).toBe("A second volunteer has to check the count.");
    expect(checkCountPeople("Marcus Hill", "Marcus\u200b Hill")).toBe("A second volunteer has to check the count.");
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

  it("compares names the way the roster does", () => {
    expect(checkCashCounter("Jordan  Lee", [{ countedBy: "Jordan Lee" }])).not.toBeNull();
  });

  it("lets a third person recount after a disagreement", () => {
    expect(checkCashCounter("Marcus Hill", [{ countedBy: "Jordan Lee" }, { countedBy: "Priya Shah" }])).toBeNull();
  });

  it("needs a name", () => {
    expect(checkCashCounter(" ", [])).toBe("Enter who counted the cash.");
  });
});

describe("checkCashCounterNotCloser", () => {
  const close = { countedBy: "Jordan Lee", checkedBy: "Marcus Hill" };
  const message = "The two volunteers who did the closing count can't count the cash. Ask someone else to count it.";

  it("keeps the counter and the checker of the closing count away from the cash", () => {
    expect(checkCashCounterNotCloser("Jordan Lee", close)).toBe(message);
    expect(checkCashCounterNotCloser(" marcus  HILL", close)).toBe(message);
    expect(checkCashCounterNotCloser("Priya Shah", close)).toBeNull();
  });

  it("has nothing to check before a closing count exists", () => {
    expect(checkCashCounterNotCloser("Jordan Lee", null)).toBeNull();
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
