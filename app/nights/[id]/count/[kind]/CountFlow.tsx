"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BoxOverlay, skuColors } from "@/components/count/BoxOverlay";
import { CountEditor, recountWarnings, type EditorItem, type FloorInfo } from "@/components/count/CountEditor";
import { PhotoCapture } from "@/components/count/PhotoCapture";
import { PersonSelect } from "@/components/PersonSelect";
import { Callout, Card, buttonClass, cx } from "@/components/ui";
import type { Counts } from "@/lib/engine/reconcile";
import type { Person } from "@/lib/repo";
import type { Confidence, CountResult } from "@/lib/vision/schema";

export type FloorMap = Record<string, FloorInfo>;

interface SuggestResponse {
  suggestionId: string | null;
  provider: "gemini" | "replay" | "manual";
  model: string | null;
  result: CountResult | null;
  message?: string;
}

type Phase = "photo" | "counting" | "review";

const FALLBACK = "The photo count did not work this time. Count by hand; the photo is still saved.";

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
  floor,
  initialCounts,
  initialWaste,
}: {
  nightId: string;
  kind: "open" | "close";
  items: EditorItem[];
  people: Person[];
  floor: FloorMap | null;
  initialCounts: Counts | null;
  initialWaste: Counts | null;
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
  const abortRef = useRef<AbortController | null>(null);
  const elapsed = useElapsed(phase === "counting");

  useEffect(() => () => abortRef.current?.abort(), []);

  const result = suggestion?.result ?? null;
  const suggestedCounts = useMemo(() => (result ? Object.fromEntries(result.items.map((i) => [i.sku, i.count])) : null), [result]);
  const confidence = useMemo(
    () => (result ? (Object.fromEntries(result.items.map((i) => [i.sku, i.confidence])) as Record<string, Confidence>) : null),
    [result],
  );
  const warnings = recountWarnings(items, counts, kind === "close" ? waste : null, floor);
  const warningCount = Object.keys(warnings).length;
  const toCheck = result ? result.items.filter((i) => i.confidence !== "high").map((i) => nameOf.get(i.sku) ?? i.sku) : [];
  const changedCount = suggestedCounts ? items.filter((i) => (suggestedCounts[i.sku] ?? 0) !== (counts[i.sku] ?? 0)).length : 0;

  async function onUploaded(p: { sha256: string; url: string }) {
    setPhoto(p);
    setSuggestion(null);
    setReason(null);
    setHighlight(null);
    setPhase("counting");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/nights/${encodeURIComponent(nightId)}/suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, sha256: p.sha256 }),
        signal: controller.signal,
      });
      const body = (await res.json()) as SuggestResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? FALLBACK);
      setSuggestion(body);
      if (body.result) {
        setCounts(Object.fromEntries(items.map((i) => [i.sku, body.result?.items.find((r) => r.sku === i.sku)?.count ?? 0])));
      }
      setReason(body.result ? body.message ?? null : body.message ?? FALLBACK);
    } catch (err) {
      if (controller.signal.aborted) return;
      setReason((err as Error).message || FALLBACK);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setPhase("review");
    }
  }

  function countByHand(why: string) {
    abortRef.current?.abort();
    abortRef.current = null;
    setSuggestion(null);
    setReason(why);
    setPhase("review");
  }

  function retake() {
    abortRef.current?.abort();
    setPhase("photo");
  }

  async function save() {
    setError(null);
    if (!countedBy || !checkedBy) {
      setError("Choose who counted and who checked.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/nights/${encodeURIComponent(nightId)}/counts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          counts,
          ...(kind === "close" ? { waste } : {}),
          countedBy,
          checkedBy,
          sha256: photo?.sha256 ?? null,
          suggestionId: suggestion?.suggestionId ?? null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Saving failed (HTTP ${res.status}).`);
      router.push(kind === "open" ? `/nights/${nightId}` : `/nights/${nightId}/close`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
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
            items={result.items.map((i) => ({ sku: i.sku, name: nameOf.get(i.sku) ?? i.sku, color: colors[i.sku] ?? "#475569", boxes: i.boxes }))}
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
            Each box is one counted item. Tap an item to see only its boxes. Check every number against the table and fix any that are off.
            {suggestion?.provider === "replay" && " (This is a recorded result for this sample photo.)"}
            {reason && <span className="mt-1 block">{reason}</span>}
          </Callout>
        ) : (
          <Callout tone="warn" title="Count by hand">{reason ?? FALLBACK}</Callout>
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
          floor={floor}
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
        {error && <Callout tone="bad">{error}</Callout>}

        <button type="button" onClick={save} disabled={saving} className={cx(buttonClass("primary", "lg"), "w-full")}>
          {saving ? "Saving…" : kind === "open" ? "Save opening count" : "Save closing count"}
        </button>
      </div>
    </div>
  );
}
