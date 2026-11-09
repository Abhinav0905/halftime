import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { redactOrder } from "@/lib/redact";
import { getNightState } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { WindowBoard } from "@/components/WindowBoard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Window board" };

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ensureSeeded();
  const state = getNightState(id);
  if (!state) notFound();
  // The board is a client component, so buyer emails and capture ids are left out of what it receives.
  return <WindowBoard nightId={id} title={state.night.title} initialStatus={state.night.status} initialOrders={state.orders.map(redactOrder)} />;
}
