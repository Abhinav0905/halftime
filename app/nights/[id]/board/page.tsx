import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  return <WindowBoard nightId={id} title={state.night.title} initialStatus={state.night.status} initialOrders={state.orders} />;
}
