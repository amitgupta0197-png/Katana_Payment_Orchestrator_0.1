// GET /api/settlements/export — downloadable reconciliation report (CSV, BRD §12).
// Scoped exactly like the settlement list: admin = all (optional ?provider=&branch=&status=),
// provider = own, branch = addressed to it. One row per settlement with the full
// deduction breakdown, mode details, evidence refs, and rule version.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

const esc = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);

  const where: string[] = []; const args: unknown[] = [];
  try {
    if (s.persona === "PROVIDER") { args.push(s.scope_id); where.push(`pbs.provider_id = $${args.length}::uuid`); }
    else if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      args.push(keys); where.push(`pbs.merchant_key = ANY($${args.length}::text[])`);
    } else {
      const fp = url.searchParams.get("provider");
      if (fp) { args.push(fp); where.push(`pbs.provider_id = $${args.length}::uuid`); }
      const fb = url.searchParams.get("branch");
      if (fb) { args.push(fb); where.push(`pbs.merchant_key = $${args.length}`); }
    }
    const fs = url.searchParams.get("status");
    if (fs) { args.push(fs); where.push(`pbs.status = $${args.length}`); }

    const list = await rows<Record<string, unknown>>("provider", `
      SELECT pbs.request_ref, p.legal_name AS upline_name, pbs.merchant_key AS downline_branch,
             pbs.gross_amount, (pbs.charges->>'upline_charge')::float AS upline_commission,
             (pbs.charges->>'katana_charge')::float AS katana_commission,
             (pbs.charges->>'downline_charge')::float AS downline_commission,
             (pbs.charges->>'fixed_fee')::float AS fixed_fee, (pbs.charges->>'gst')::float AS gst,
             (pbs.charges->>'total_charges')::float AS total_deductions,
             pbs.net_amount, pbs.amount AS legacy_amount, pbs.currency, pbs.settle_mode,
             pbs.usdt_network, pbs.usdt_rate, pbs.usdt_quantity, pbs.wallet_address,
             pbs.utr, pbs.tx_hash, CASE WHEN pbs.receipt_uri IS NULL THEN 'no' ELSE 'yes' END AS receipt_uploaded,
             pbs.status, pbs.purpose, pbs.rule_version,
             pbs.requested_by, pbs.requested_at, pbs.accepted_at, pbs.paid_at,
             pbs.confirmed_at, pbs.reconciled_at, pbs.note
        FROM provider_branch_settlements pbs
        LEFT JOIN providers p ON p.id = pbs.provider_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY pbs.created_at DESC LIMIT 5000
    `, args);

    const headers = [
      "request_id", "upline", "downline_branch", "gross_amount", "upline_commission", "katana_commission",
      "downline_commission", "fixed_fee", "gst", "total_deductions", "net_settlement", "currency", "mode",
      "usdt_network", "usdt_rate", "usdt_quantity", "wallet_address", "utr", "tx_hash", "receipt_uploaded",
      "status", "purpose", "rule_version", "requested_by", "requested_at", "accepted_at", "paid_at",
      "confirmed_at", "reconciled_at", "remarks",
    ];
    const keyMap: Record<string, string> = { request_id: "request_ref", upline: "upline_name", net_settlement: "net_amount", mode: "settle_mode", remarks: "note" };
    const lines = [headers.join(",")];
    for (const r of list)
      lines.push(headers.map((h) => esc(r[keyMap[h] ?? h])).join(","));

    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="katana-settlement-recon-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
