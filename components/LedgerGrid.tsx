"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type RowClickedEvent, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef } from "react";
import type { LedgerRow } from "@/lib/repo";
import { formatCents, formatVariance } from "@/lib/money";
import { formatGameDate } from "./format";
import { buttonClass } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#1d3a6e",
  foregroundColor: "#13203a",
  headerBackgroundColor: "#f6f7f9",
  borderColor: "#dfe3ea",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontWeight: 600,
});

// Money is shown in dollars in the grid so the number filters read the way people type.
interface GridRow {
  nightId: string | null;
  date: string;
  title: string;
  sample: boolean;
  status: string;
  paypal: number | null;
  expectedCash: number | null;
  counted: number | null;
  cashVariance: number | null;
  cashBand: string | null;
  deposited: number | null;
  depositVariance: number | null;
  depositBand: string | null;
  total: number | null;
  paypalShare: number | null;
}

const STATUS_TEXT: Record<string, string> = {
  setup: "Opening count",
  selling: "Selling",
  closing: "Closing",
  closed: "Awaiting deposit",
  deposited: "Deposited",
};

const dollars = (cents: number | null) => (cents === null ? null : cents / 100);
const money = (p: ValueFormatterParams<GridRow, number | null>) => (p.value === null || p.value === undefined ? "—" : formatCents(Math.round(p.value * 100)));
const variance = (p: ValueFormatterParams<GridRow, number | null>) =>
  p.value === null || p.value === undefined ? "—" : formatVariance(Math.round(p.value * 100));

function bandRules(field: "cashBand" | "depositBand") {
  return {
    "ledger-ok": (p: { data?: GridRow }) => p.data?.[field] === "green",
    "ledger-warn": (p: { data?: GridRow }) => p.data?.[field] === "amber",
    "ledger-bad": (p: { data?: GridRow }) => p.data?.[field] === "red",
  };
}

function toGridRow(r: LedgerRow): GridRow {
  const total = r.totalSalesCents;
  return {
    nightId: r.nightId,
    date: r.date,
    title: r.title,
    sample: r.sample,
    status: STATUS_TEXT[r.status] ?? r.status,
    paypal: dollars(r.paypalCents),
    expectedCash: dollars(r.expectedCashSalesCents),
    counted: dollars(r.countedCents),
    cashVariance: dollars(r.cashVarianceCents),
    cashBand: r.cashBand,
    deposited: dollars(r.depositCents),
    depositVariance: dollars(r.depositVarianceCents),
    depositBand: r.depositBand,
    total: dollars(total),
    paypalShare: total ? Math.round((r.paypalCents / total) * 1000) / 10 : null,
  };
}

function sum(rows: GridRow[], key: keyof GridRow): number | null {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
  return vals.length ? Math.round(vals.reduce((s, v) => s + v * 100, 0)) / 100 : null;
}

export function LedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const router = useRouter();
  const apiRef = useRef<GridApi<GridRow> | null>(null);
  const data = useMemo(() => rows.map(toGridRow), [rows]);

  const totals = useMemo<GridRow[]>(() => {
    const paypal = sum(data, "paypal");
    const total = sum(data, "total");
    const paypalOnPricedNights = sum(data.filter((r) => r.total !== null), "paypal");
    return [
      {
        nightId: null,
        date: "",
        title: "Season total",
        sample: false,
        status: `${data.length} ${data.length === 1 ? "game" : "games"}`,
        paypal,
        expectedCash: sum(data, "expectedCash"),
        counted: sum(data, "counted"),
        cashVariance: sum(data, "cashVariance"),
        cashBand: null,
        deposited: sum(data, "deposited"),
        depositVariance: sum(data, "depositVariance"),
        depositBand: null,
        total,
        paypalShare: total && paypalOnPricedNights !== null ? Math.round((paypalOnPricedNights / total) * 1000) / 10 : null,
      },
    ];
  }, [data]);

  const columns = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        field: "date",
        headerName: "Date",
        width: 130,
        sort: "desc",
        filter: "agTextColumnFilter",
        valueFormatter: (p) => (p.value ? formatGameDate(p.value as string) : ""),
      },
      {
        field: "title",
        headerName: "Game",
        minWidth: 220,
        flex: 1,
        filter: "agTextColumnFilter",
        cellRenderer: (p: { value: string; data?: GridRow }) => (
          <span>
            {p.value}
            {p.data?.sample && <span className="ml-2 rounded-full border border-line bg-paper px-2 py-0.5 text-xs font-semibold text-ink-soft">Sample</span>}
          </span>
        ),
      },
      { field: "status", headerName: "Status", width: 150, filter: "agTextColumnFilter" },
      { field: "paypal", headerName: "PayPal sales", width: 135, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: money },
      { field: "expectedCash", headerName: "Expected cash", width: 140, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: money },
      { field: "counted", headerName: "Counted", width: 120, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: money },
      {
        field: "cashVariance",
        headerName: "Cash variance",
        width: 140,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: variance,
        cellClassRules: bandRules("cashBand"),
      },
      { field: "deposited", headerName: "Deposited", width: 125, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: money },
      {
        field: "depositVariance",
        headerName: "Deposit variance",
        width: 150,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: variance,
        cellClassRules: bandRules("depositBand"),
      },
      { field: "total", headerName: "Total sales", width: 130, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: money },
      {
        field: "paypalShare",
        headerName: "PayPal share",
        width: 130,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : `${p.value}%`),
      },
    ],
    [],
  );

  function onRowClicked(e: RowClickedEvent<GridRow>) {
    if (e.rowPinned || !e.data?.nightId) return;
    router.push(`/nights/${e.data.nightId}`);
  }

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          className={buttonClass("secondary")}
          onClick={() => apiRef.current?.exportDataAsCsv({ fileName: "halftime-season.csv" })}
        >
          Download CSV
        </button>
      </div>
      <div className="ledger-grid">
        <AgGridReact<GridRow>
          theme={theme}
          rowData={data}
          columnDefs={columns}
          pinnedBottomRowData={totals}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
          domLayout="autoHeight"
          rowClass="cursor-pointer"
          getRowId={(p) => p.data.nightId ?? "total"}
          onGridReady={(e) => {
            apiRef.current = e.api;
          }}
          onRowClicked={onRowClicked}
          overlayNoRowsTemplate="No games yet. Start one from the home page."
        />
      </div>
      <style>{`
        .ledger-grid .ledger-ok { background: var(--color-ok-soft); color: var(--color-ok); font-weight: 600; }
        .ledger-grid .ledger-warn { background: var(--color-warn-soft); color: var(--color-warn); font-weight: 600; }
        .ledger-grid .ledger-bad { background: var(--color-bad-soft); color: var(--color-bad); font-weight: 600; }
        .ledger-grid .ag-row-pinned { font-weight: 700; cursor: default; }
      `}</style>
    </div>
  );
}
