// What a volunteer should do next on a given night. One place, so the home
// card and the night page never disagree.

import type { NightStatus } from "@/lib/repo";
import type { CashStatus } from "@/lib/engine/reconcile";

export interface NextStep {
  text: string;
  action: { label: string; href: string } | null;
  secondary?: { label: string; href: string };
}

export function nextStep(input: {
  id: string;
  status: NightStatus;
  cashStatus: CashStatus;
  recount: boolean;
}): NextStep {
  const base = `/nights/${input.id}`;
  switch (input.status) {
    case "setup":
      return {
        text: "Photograph the stocked table before the stand opens. A second volunteer checks the count.",
        action: { label: "Count opening stock", href: `${base}/count/open` },
      };
    case "selling":
      return {
        text: "The stand is open. Fans pay at the booth QR code. When the game ends, photograph what is left.",
        action: { label: "Count leftovers", href: `${base}/count/close` },
        secondary: { label: "Window board", href: `${base}/board` },
      };
    case "closing": {
      // Counting the cash locks the closing count, so a recount only helps before the first cash count.
      if (input.recount && input.cashStatus === "missing") {
        return {
          text: "Some items need a recount. Recount them before anyone counts the cash, because counting the cash locks the closing count.",
          action: { label: "Recount leftovers", href: `${base}/count/close` },
          secondary: { label: "Review the close-out", href: `${base}/close` },
        };
      }
      const note = input.recount ? " Some items didn't add up, so add a note about them when you finalize." : "";
      if (input.cashStatus === "agree") {
        return {
          text: `Both cash counts match. Review the result and finalize the night.${note}`,
          action: { label: "Finalize close-out", href: `${base}/close` },
        };
      }
      if (input.cashStatus === "disagree") {
        return {
          text: `The two cash counts are different. Count the box again.${note}`,
          action: { label: "Recount the cash", href: `${base}/close` },
        };
      }
      return {
        text:
          (input.cashStatus === "single"
            ? "One cash count is in. A second volunteer counts the box without seeing the first number."
            : "Two volunteers who weren't on the closing count each count the cash box, without seeing each other's number.") +
          note,
        action: { label: "Count the cash", href: `${base}/close` },
      };
    }
    case "closed":
      return {
        text: "The close-out is finalized. Someone who did not count the cash takes it to the bank and records the deposit.",
        action: { label: "Record the deposit", href: `${base}/deposit` },
      };
    case "deposited":
      return {
        text: "Deposit recorded. This game is complete.",
        action: null,
      };
  }
}
