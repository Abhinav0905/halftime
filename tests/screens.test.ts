import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recountWarnings } from "@/components/count/CountEditor";
import { GameDayLabel, TonightDate } from "@/components/GameDay";
import { nextStep } from "@/components/nextStep";
import { formatGameDate, fundingLabel, itemsSummary, todayLocalIso } from "@/components/format";

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

  it("asks for the recount before the cash is counted", () => {
    const s = nextStep({ ...base, status: "closing", recount: true });
    expect(s.action).toEqual({ label: "Recount leftovers", href: "/nights/n1/count/close" });
    expect(s.text).toMatch(/before anyone counts the cash/);
    expect(s.secondary?.href).toBe("/nights/n1/close");
  });

  it("asks for a note instead of a recount once cash counting has started", () => {
    for (const cashStatus of ["single", "disagree", "agree"] as const) {
      const s = nextStep({ ...base, status: "closing", cashStatus, recount: true });
      expect(s.action?.href).toBe("/nights/n1/close");
      expect(s.text).toMatch(/add a note about them when you finalize/);
    }
    expect(nextStep({ ...base, status: "closing", cashStatus: "agree", recount: false }).text).not.toMatch(/note/);
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

describe("recountWarnings", () => {
  const items = [{ sku: "hotdog", name: "Hot dog" }, { sku: "water", name: "Water" }];
  // At most 14 hot dogs can be left; water had no PayPal sales, so it has no cap.
  const caps = { hotdog: 14 };

  it("says nothing while the counts are possible", () => {
    expect(recountWarnings(items, { hotdog: 14, water: 40 }, null, caps)).toEqual({});
  });

  it("warns once a count is over the cap, minus waste", () => {
    expect(recountWarnings(items, { hotdog: 15, water: 0 }, null, caps).hotdog).toBe("PayPal's sales show no more than 14 can be left. Please recount.");
    expect(recountWarnings(items, { hotdog: 13, water: 0 }, { hotdog: 2, water: 0 }, caps).hotdog).toMatch(/no more than 12/);
  });

  it("points at the waste or the opening count when no leftover count could work", () => {
    expect(recountWarnings(items, { hotdog: 0, water: 0 }, { hotdog: 15, water: 0 }, caps).hotdog).toMatch(/Check the waste entry/);
    expect(recountWarnings(items, { hotdog: 0, water: 0 }, null, { hotdog: -1 }).hotdog).toMatch(/opening count may be off/);
  });
});

describe("game day label", () => {
  it("never says Tonight from the server, since only the browser knows the viewer's day", () => {
    const today = todayLocalIso();
    expect(renderToStaticMarkup(createElement(GameDayLabel, { date: today }))).toBe(`<span>${formatGameDate(today, { year: true })}</span>`);
    expect(renderToStaticMarkup(createElement(TonightDate, { date: today }))).toBe("");
  });
});
