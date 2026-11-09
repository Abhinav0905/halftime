// The instruction sent with each count photo. Kept short: the response schema
// already fixes the output shape, so the words only need to say how to count.

import type { CatalogRef } from "./schema";

export function buildCountPrompt(catalog: readonly CatalogRef[]): string {
  const menu = catalog
    .map((i) => `- sku "${i.sku}": ${i.name}${i.description ? ` (${i.description})` : ""}`)
    .join("\n");

  return `This photo shows a school concession stand table. Count the menu items on it.

Menu:
${menu}

How to count:
1. Return one entry in "items" for every menu sku above, in the same order. Use count 0 when none are visible.
2. Count individual units, not packs or rows. Count a unit even when it is partly hidden behind another, as long as some of it is visible. In a stack, count every layer whose edge you can see.
3. Draw one box per counted unit as [ymin, xmin, ymax, xmax] on a 0-1000 grid over the whole photo. List the boxes first, then set count to the number of units.
4. confidence: "high" when every unit is clearly separate, "medium" when some overlap or are partly hidden, "low" when you had to estimate.
5. Put anything that is not on the menu in "unknown" with a short plain label and a count. Do not force it into a menu item.
6. List photo problems in "quality" as short phrases, for example "glare", "blurry", "items cut off at the edge", "items stacked", "too dark". Leave it empty when the photo is fine.
7. Only count. Do not estimate prices, totals or money.`;
}
