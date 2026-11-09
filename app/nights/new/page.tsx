import { NewNightForm } from "@/components/NewNightForm";
import { todayLocalIso } from "@/components/format";
import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function NewNightPage() {
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Start tonight's game"
        subtitle="Next you will photograph the stocked table. The booth QR code opens once that count is confirmed."
        back={{ href: "/", label: "Home" }}
      />
      <Card>
        <NewNightForm defaultDate={todayLocalIso()} />
      </Card>
    </div>
  );
}
