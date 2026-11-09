// Names in Halftime are picked from the club roster. The server checks every
// name against the roster so separation-of-duty rules can't be sidestepped by
// typing "Marcus  Hill" or "marcus hill " as a different person.

import { HttpError } from "./http";
import { listPeople, type Person } from "./repo";

export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The roster entry for a typed name, or null if nobody on the roster matches. */
export function findPerson(name: string, people: Person[] = listPeople()): Person | null {
  const key = normalizeName(name);
  if (!key) return null;
  return people.find((p) => normalizeName(p.name) === key) ?? null;
}

/**
 * Returns the roster spelling of `name`, or throws a 400 the volunteer can act on.
 * `roles` limits who may do the step (for example only officers or the treasurer approve payouts).
 */
export function requireRosterName(name: string, label: string, roles?: Person["role"][]): string {
  const person = findPerson(name);
  if (!person) throw new HttpError(400, `${label} has to be someone on the club roster.`);
  if (roles && !roles.includes(person.role)) {
    throw new HttpError(403, `${label} has to be ${roles.join(" or ")}. ${person.name} is listed as ${person.role}.`);
  }
  return person.name;
}
