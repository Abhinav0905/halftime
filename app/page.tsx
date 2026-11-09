import { getLedger } from "@/lib/repo";
export default function Home() {
  return <pre>{JSON.stringify(getLedger().map((r) => [r.title, r.cashBand, r.depositBand]))}</pre>;
}
