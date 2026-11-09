// Separation of duties. Each check returns an error message for the volunteer,
// or null when the action is allowed. Kept pure so the API and tests share it.
// Routes pass roster spellings (lib/roster.ts); samePerson still normalizes so
// names saved before the roster check compare the same way.

import { samePerson } from "./reconcile";

export function checkCountPeople(countedBy: string, checkedBy: string): string | null {
  if (!countedBy.trim() || !checkedBy.trim()) return "Both the counter and the checker need a name.";
  if (samePerson(countedBy, checkedBy)) return "A second volunteer has to check the count.";
  return null;
}

export function checkCashCounter(countedBy: string, previous: { countedBy: string }[]): string | null {
  if (!countedBy.trim()) return "Enter who counted the cash.";
  const last = previous[previous.length - 1];
  if (last && samePerson(last.countedBy, countedBy)) {
    return "The next cash count has to be done by a different volunteer.";
  }
  return null;
}

/** The two who did the closing count could work out the expected cash, so neither counts the box. */
export function checkCashCounterNotCloser(countedBy: string, close: { countedBy: string; checkedBy: string } | null): string | null {
  if (!close) return null;
  if (samePerson(close.countedBy, countedBy) || samePerson(close.checkedBy, countedBy)) {
    return "The two volunteers who did the closing count can't count the cash. Ask someone else to count it.";
  }
  return null;
}

export function checkDepositor(depositor: string, cashCounters: string[]): string | null {
  if (!depositor.trim()) return "Enter who made the deposit.";
  if (cashCounters.some((c) => samePerson(c, depositor))) {
    return "The deposit should be made by someone who did not count the cash.";
  }
  return null;
}

export function checkApprover(approver: string, requester: string, openingCountDone: boolean): string | null {
  if (!approver.trim()) return "Enter who is approving.";
  if (samePerson(approver, requester)) return "Someone other than the requester has to approve.";
  if (!openingCountDone) return "Confirm the opening count first, so the receipt can be checked against it.";
  return null;
}
