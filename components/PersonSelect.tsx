"use client";

import type { Person } from "@/lib/repo";
import { Field, inputClass } from "./ui";

/** Pick a volunteer from the club roster. `exclude` hides people who already did a conflicting step. */
export function PersonSelect({
  label,
  people,
  value,
  onChange,
  exclude = [],
  hint,
  error,
  roles,
}: {
  label: string;
  people: Person[];
  value: string;
  onChange: (name: string) => void;
  exclude?: string[];
  hint?: string;
  error?: string | null;
  roles?: Person["role"][];
}) {
  const excluded = new Set(exclude.map((e) => e.trim().toLowerCase()));
  const options = people.filter((p) => (!roles || roles.includes(p.role)) && !excluded.has(p.name.toLowerCase()));
  return (
    <Field label={label} hint={hint} error={error}>
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a name…</option>
        {options.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}{p.role !== "volunteer" ? ` (${p.role})` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}
