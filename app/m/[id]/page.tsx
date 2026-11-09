import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClub, getNight, listItems } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { paypalConfig, paypalConfigured } from "@/lib/config";
import { MAX_UNITS_PER_LINE } from "@/lib/paypal/payload";
import { BuyerMenu } from "@/components/BuyerMenu";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order and pay" };

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  ensureSeeded();
  const night = getNight(id);
  if (!night) notFound();
  const club = getClub();
  const items = listItems().map((i) => ({ sku: i.sku, name: i.name, priceCents: i.priceCents }));

  return (
    <BuyerMenu
      nightId={night.id}
      clubName={club.name}
      gameTitle={night.title}
      status={night.status}
      items={items}
      maxPerLine={MAX_UNITS_PER_LINE}
      paypalClientId={paypalConfigured() ? paypalConfig().clientId : null}
      mockDecline={query.decline === "1"}
    />
  );
}
