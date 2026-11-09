"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BoxOverlay, skuColors } from "@/components/count/BoxOverlay";
import { CountEditor, recountWarnings, type EditorItem, type LeftoverCaps } from "@/components/count/CountEditor";
import { PhotoCapture } from "@/components/count/PhotoCapture";
import { PersonSelect } from "@/components/PersonSelect";
import { postJson } from "@/components/api";
import { Callout, Card, buttonClass, cx } from "@/components/ui";
import type { Counts } from "@/lib/engine/reconcile";
import type { Person } from "@/lib/repo";
import { MESSAGES } from "@/lib/vision/messages";
import type { Confidence, CountResult } from "@/lib/vision/schema";

interface SuggestResponse {
  suggestionId: string | null;
  provider: "gemini" | "replay" | "manual";
  model: string | null;
  result: CountResult | null;
  message?: string;
}

type Phase = "photo" | "counting" | "review";

const NO_CONNECTION = "No connection, so the photo count was skipped. Count by hand; the photo is still saved.";

function zeros(items: EditorItem[]): Counts {
  return Object.fromEntries(items.map((i) => [i.sku, 0]));
}

function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const started = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);
  return seconds;
}

export function CountFlow({
  nightId,
  kind,
  items,
  people,
  caps,
  initialCounts,
  initialWaste,
  demoPhoto,
  closesMenu,
}: {
  nightId: string;
  kind: "open" | "close";
  items: EditorItem[];
  people: Person[];
  caps: LeftoverCaps | null;
  initialCounts: Counts | null;
  initialWaste: Counts | null;
  /** URL of a bundled sample photo for this count, when one is installed. */
  demoPhoto: string | null;
  /** Saving this count moves the night out of selling, which stops new fan orders. */
  closesMenu: boolean;
}) {
  const router = useRouter();
  const colors = useMemo(() => skuColors(items.map((i) => i.sku)), [items]);
  const nameOf = useMemo(() => new Map(items.map((i) => [i.sku, i.name])), [items]);

  const [phase, setPhase] = useState<Phase>("photo");
  const [photo, setPhoto] = useState<{ sha256: string; url: string } | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestResponse | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>(() => ({ ...zeros(items), ...(initialCounts ?? {}) }));
  const [waste, setWaste] = useState<Counts>(() => ({ ...zeros(items), ...(initialWaste ?? {}) }));
  const [countedBy, setCountedBy] = useState("");
  const [checkedBy, setCheckedBy] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever a pending photo count should be ignored: a retake or counting by hand.
  const requestRef = useRef(0);
  const elapsed = useElapsed(phase === "counting");

  const result = suggestion?.result ?? null;
  const suggestedCounts = useMemo(() => (result ? Object.fromEntries(result.items.map((i) => [i.sku, i.count])) : null), [result]);
  const confidence = useMemo(
    () => (result ? (Object.fromEntries(result.items.map((i) => [i.sku, i.confidence])) as Record<string, Confidence>) : null),
    [result],
  );
  const warnings = recountWarnings(items, counts, kind === "close" ? waste : null, caps);
  const warningCount = Object.keys(warnings).length;
  const toCheck = result ? result.items.filter((i) => i.confidence !== "high").map((i) => nameOf.get(i.sku) ?? i.sku) : [];
  const changedCount = suggestedCounts ? items.filter((i) => (suggestedCounts[i.sku] ?? 0) !== (counts[i.sku] ?? 0)).length : 0;

  async function onUploaded(p: { sha256: string; url: string }) {
    const request = ++requestRef.current;
    setPhoto(p);
    setSuggestion(null);
    setReason(null);
    setHighlight(null);
    setPhase("counting");
    const res = await postJson<SuggestResponse>(`/api/nights/${encodeURIComponent(nightId)}/suggest`, { kind, sha256: p.sha256 });
    if (request !== requestRef.current) return;
    if (res.ok && res.data) {
      const body = res.data;
      const suggested = body.result;
      setSuggestion(body);
      if (suggested) setCounts(Object.fromEntries(items.map((i) => [i.sku, suggested.items.find((r) => r.sku === i.sku)?.count ?? 0])));
      setReason(suggested ? body.message ?? null : body.message ?? MESSAGES.failed);
    } else if (res.status === 0) {
      setReason(NO_CONNECTION);
    } else {
      // Show the server's own plain message when there is one; a proxy error page gets the standard fallback.
      setReason(!res.ok && typeof res.data?.error === "string" ? res.error : MESSAGES.failed);
    }
    setPhase("review");
  }

  function countByHand(why: string) {
    requestRef.current++;
    setSuggestion(null);
    setReason(why);
    setPhase("review");
  }

  function retake() {
    requestRef.current++;
    setPhase("photo");
  }

  async function save() {
    setError(null);
    if (!countedBy || !checkedBy) {
      setError("Choose who counted and who checked.");
      return;
    }
    setSaving(true);
    const res = await postJson<{ status: string }>(`/api/nights/${encodeURIComponent(nightId)}/counts`, {
      kind,
      counts,
      ...(kind === "close" ? { waste } : {}),
      countedBy,
      checkedBy,
      sha256: photo?.sha256 ?? null,
      suggestionId: suggestion?.suggestionId ?? null,
    });
    if (!res.ok) {
      setError(res.error);
      setSaving(false);
      return;
    }
    router.push(kind === "open" ? `/nights/${nightId}` : `/nights/${nightId}/close`);
    router.refresh();
  }

  if (phase === "photo") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Card>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>Lay the items flat on the table with some space between them.</li>
            <li>Hold the phone above the table so the whole table fits in the photo.</li>
            <li>Check the suggested numbers against the table, then a second volunteer checks them too.</li>
          </ol>
          <PhotoCapture
            nightId={nightId}
            purpose={kind}
            onUploaded={onUploaded}
            label={kind === "open" ? "Photograph the stocked table" : "Photograph what is left"}
            demoSrc={demoPhoto}
          />
        </Card>
        <button
          type="button"
          onClick={() => {
            setPhoto(null);
            countByHand("No photo was taken for this count.");
          }}
          className="min-h-11 w-full text-center text-sm font-medium text-brand hover:underline"
        >
          No camera? Count by hand
        </button>
      </div>
    );
  }

  if (phase === "counting") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {photo && (
          <div className="overflow-hidden rounded-lg border border-line">
            <img src={photo.url} alt="The photo being counted" className="block h-auto w-full opacity-70" />
          </div>
        )}
        <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg bg-brand-soft p-4 text-brand">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden="true" />
          <span className="font-semibold">Counting…</span>
          <span className="ml-auto text-sm tabular">{elapsed} s</span>
        </div>
        <button
          type="button"
          onClick={() => countByHand("You chose to count by hand. The photo is still saved.")}
          className={cx(buttonClass("secondary", "lg"), "w-full")}
        >
          Count by hand instead
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      <div className="space-y-3 lg:sticky lg:top-4">
        {photo && result ? (
          <BoxOverlay
            src={photo.url}
            items={result.items.map((i) => ({ sku: i.sku, name: nameOf.get(i.sku) ?? i.sku, color: colors[i.sku] ?? "#475569", count: i.count, boxes: i.boxes }))}
            highlight={highlight}
            onHighlight={setHighlight}
          />
        ) : photo ? (
          <div className="overflow-hidden rounded-lg border border-line">
            <img src={photo.url} alt="The count photo" className="block h-auto w-full" />
          </div>
        ) : null}

        {result ? (
          <Callout tone="info" title="Suggested count from the photo">
            Boxes mark the items the photo count found. Units hidden behind others may have no box, so a count can be higher than its
            boxes. Tap an item to see only its boxes. Check every number against the table and fix any that are off.
            {suggestion?.provider === "replay" && !reason && " (This is the recorded count for this photo.)"}
            {reason && <span className="mt-1 block">{reason}</span>}
          </Callout>
        ) : (
          <Callout tone="warn" title="Count by hand">{reason ?? MESSAGES.failed}</Callout>
        )}

        {result && toCheck.length > 0 && (
          <p className="text-sm text-ink-soft">
            <span className="font-semibold">Look closely at:</span> {toCheck.join(", ")} (the photo count is less sure about these).
          </p>
        )}
        {result && result.quality.length > 0 && (
          <p className="text-sm text-ink-soft">
            <span className="font-semibold">Photo notes:</span> {result.quality.join("; ")}.
          </p>
        )}
        {result && result.unknown.length > 0 && (
          <p className="text-sm text-ink-soft">
            <span className="font-semibold">Also on the table, not on the menu:</span>{" "}
            {result.unknown.map((u) => `${u.label} (${u.count})`).join(", ")}.
          </p>
        )}

        <button type="button" onClick={retake} className={cx(buttonClass("secondary"), "w-full sm:w-auto")}>
          {photo ? "Retake photo" : "Take a photo instead"}
        </button>
      </div>

      <div className="space-y-5">
        <CountEditor
          items={items}
          counts={counts}
          onCountsChange={setCounts}
          suggested={suggestedCounts}
          confidence={confidence}
          colors={result ? colors : {}}
          waste={kind === "close" ? waste : null}
          onWasteChange={setWaste}
          caps={caps}
          onSelect={result ? (sku) => setHighlight((h) => (h === sku ? null : sku)) : undefined}
        />

        {suggestedCounts && changedCount > 0 && (
          <p className="text-sm text-muted">
            You changed {changedCount} of the {items.length} suggested numbers.
          </p>
        )}

        <Card title="Who counted">
          <div className="grid gap-4 sm:grid-cols-2">
            <PersonSelect
              label="Counted by"
              people={people}
              value={countedBy}
              onChange={(name) => {
                setCountedBy(name);
                if (name && name.toLowerCase() === checkedBy.toLowerCase()) setCheckedBy("");
              }}
            />
            <PersonSelect
              label="Checked by"
              people={people}
              value={checkedBy}
              onChange={setCheckedBy}
              exclude={countedBy ? [countedBy] : []}
              hint="A second volunteer looks over the table and these numbers."
            />
          </div>
        </Card>

        {warningCount > 0 && (
          <Callout tone="warn" title={`Recount ${warningCount === 1 ? "1 item" : `${warningCount} items`} before saving`}>
            PayPal&apos;s itemized sales show fewer can be left than these numbers say. If you save anyway, the close-out will ask for a recount.
          </Callout>
        )}
        {closesMenu && (
          <Callout tone="warn" title="Saving this closes the fan menu">
            Once the closing count is saved, fans can no longer start orders from the booth QR code. Save it when the stand is done
            selling.
          </Callout>
        )}
        {error && <Callout tone="bad">{error}</Callout>}

        <button type="button" onClick={save} disabled={saving} className={cx(buttonClass("primary", "lg"), "w-full")}>
          {saving ? "Saving…" : kind === "open" ? "Save opening count" : closesMenu ? "Save and close the fan menu" : "Save closing count"}
        </button>
      </div>
    </div>
  );
}
