import { describe, expect, it } from "vitest";
import { nextStep } from "@/components/nextStep";
import { formatGameDate, fundingLabel, itemsSummary } from "@/components/format";

describe("nextStep", () => {
  const base = { id: "n1", cashStatus: "missing" as const, recount: false };

  it("sends a new night to the opening count", () => {
    expect(nextStep({ ...base, status: "setup" }).action?.href).toBe("/nights/n1/count/open");
  });

  it("sends a selling night to the closing count, with the board as a secondary link", () => {
    const s = nextStep({ ...base, status: "selling" });
    expect(s.action?.href).toBe("/nights/n1/count/close");
    expect(s.secondary?.href).toBe("/nights/n1/board");
  });

  it("asks for a recount before anything else while closing", () => {
    expect(nextStep({ ...base, status: "closing", cashStatus: "agree", recount: true }).text).toMatch(/recount/);
  });

  it("walks the cash count states while closing", () => {
    expect(nextStep({ ...base, status: "closing", cashStatus: "single" }).text).toMatch(/second volunteer/);
    expect(nextStep({ ...base, status: "closing", cashStatus: "disagree" }).action?.label).toBe("Recount the cash");
    expect(nextStep({ ...base, status: "closing", cashStatus: "agree" }).action?.label).toBe("Finalize close-out");
  });

  it("points a closed night at the deposit and has nothing left once deposited", () => {
    expect(nextStep({ ...base, status: "closed" }).action?.href).toBe("/nights/n1/deposit");
    expect(nextStep({ ...base, status: "deposited" }).action).toBeNull();
  });
});

describe("format helpers", () => {
  it("formats game dates without shifting the day", () => {
    expect(formatGameDate("2026-10-24")).toBe("Sat, Oct 24");
    expect(formatGameDate("2026-11-08", { year: true })).toBe("Sun, Nov 8, 2026");
  });

  it("labels offline demo orders by their SIM- id, not the stored funding", () => {
    expect(fundingLabel({ id: "SIM-abc", funding: "paypal", simulated: true })).toBe("Offline demo");
    expect(fundingLabel({ id: "SAMPLE-0926-001", funding: "venmo", simulated: true })).toBe("Venmo");
    expect(fundingLabel({ id: "5O190127TN364715T", funding: "paypal", simulated: false })).toBe("PayPal");
  });

  it("summarises order lines", () => {
    expect(itemsSummary([{ name: "Hot dog", quantity: 2 }, { name: "Water", quantity: 1 }])).toBe("2 × Hot dog, 1 × Water");
  });
});
