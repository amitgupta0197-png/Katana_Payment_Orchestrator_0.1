// POST /api/_sandbox/merchant-receiver — local merchant webhook stand-in.
//
// Behaviour:
//   default                  → 200 OK
//   ?fail=true               → 500 (every attempt fails — drives retry/DLQ)
//   ?fail_until_attempt=N    → 500 until x-attempt header >= N, then 200
//   ?slow=ms                 → adds a delay (capped at 3000ms)
//
// Sandbox-only: middleware whitelists /api/_sandbox/* as public.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const failAlways = url.searchParams.get("fail") === "true";
  const failUntil = Number(url.searchParams.get("fail_until_attempt") ?? "0");
  const slow = Math.min(Number(url.searchParams.get("slow") ?? "0"), 3000);
  const attempt = Number(req.headers.get("x-attempt") ?? "1");

  if (slow > 0) await new Promise((r) => setTimeout(r, slow));

  if (failAlways || (failUntil > 0 && attempt < failUntil)) {
    return new Response(JSON.stringify({ ok: false, reason: "sandbox-failure", attempt }),
      { status: 500, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, attempt }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
