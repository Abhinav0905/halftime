import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { centsToValue, formatCents, formatVariance, parseDollarInput, valueToCents } from "../lib/money";

describe("formatCents", () => {
  it("formats dollars and cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(2700)).toBe("$27.00");
    expect(formatCents(105_250)).toBe("$1,052.50");
  });

  it("uses a real minus sign for negatives", () => {
    expect(formatCents(-2700)).toBe("−$27.00");
  });
});

describe("formatVariance", () => {
  it("signs the amount", () => {
    expect(formatVariance(0)).toBe("$0.00");
    expect(formatVariance(200)).toBe("+$2.00");
    expect(formatVariance(-2700)).toBe("−$27.00");
  });
});

describe("PayPal amount values", () => {
  it("converts cents to PayPal's two-decimal string", () => {
    expect(centsToValue(0)).toBe("0.00");
    expect(centsToValue(7)).toBe("0.07");
    expect(centsToValue(700)).toBe("7.00");
    expect(centsToValue(123_456)).toBe("1234.56");
  });

  it("refuses fractional or negative cents", () => {
    expect(() => centsToValue(1.5)).toThrow();
    expect(() => centsToValue(-1)).toThrow();
  });

  it("parses PayPal values strictly", () => {
    expect(valueToCents("7.00")).toBe(700);
    expect(valueToCents("7.5")).toBe(750);
    expect(valueToCents("7")).toBe(700);
    expect(() => valueToCents("7.001")).toThrow();
    expect(() => valueToCents("-1.00")).toThrow();
    expect(() => valueToCents("abc")).toThrow();
  });

  it("round-trips every amount exactly", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), (cents) => valueToCents(centsToValue(cents)) === cents));
  });
});

describe("parseDollarInput", () => {
  it("reads what volunteers type", () => {
    expect(parseDollarInput("52")).toBe(5200);
    expect(parseDollarInput("52.5")).toBe(5250);
    expect(parseDollarInput("$52.50")).toBe(5250);
    expect(parseDollarInput("1,052.00")).toBe(105_200);
    expect(parseDollarInput(" 3. ")).toBe(300);
  });

  it("returns null for anything else", () => {
    expect(parseDollarInput("")).toBeNull();
    expect(parseDollarInput("12.345")).toBeNull();
    expect(parseDollarInput("-5")).toBeNull();
    expect(parseDollarInput("five")).toBeNull();
  });

  it("agrees with formatCents", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), (cents) => parseDollarInput(formatCents(cents)) === cents));
  });
});
