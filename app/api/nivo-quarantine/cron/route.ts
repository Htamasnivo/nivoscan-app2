import { NextRequest, NextResponse } from "next/server";

// app/api/nivo-quarantine/cron/route.ts
// Tartalék 5 perces szerveroldali küldési próbálkozás, ha a dolgozói fül
// karantén után megszakad, de a legutolsó heartbeat már bekerült a Supabase-ba.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Nincs jogosultság." }, { status: 401 });
  }
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hghvhsrjfwvaafkfhiyj.supabase.co").replace(/\/$/, "");
  const key = process.env.NIVO_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key) return NextResponse.json({ error: "Hiányzik a service role kulcs." }, { status: 503 });

  try {
    const recent = new Date(Date.now() - 31 * 60_000).toISOString();
    const response = await fetch(
      `${url}/rest/v1/nivo_machine_activity?select=machine_id,client_id,last_error,last_error_at,request_count_1m&last_error_at=gt.${encodeURIComponent(recent)}&limit=100`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!response.ok) return NextResponse.json({ error: `Supabase HTTP ${response.status}` }, { status: 503 });
    const rows = await response.json() as Array<{
      machine_id: string;
      client_id: string | null;
      last_error: string | null;
      last_error_at: string | null;
      request_count_1m: number | null;
    }>;
    let checked = 0;
    let failed = 0;
    for (const row of rows) {
      if (!row.client_id || !row.last_error?.startsWith("AUTOMATIKUS VÉDELEM:") || !row.last_error_at) continue;
      const started = new Date(row.last_error_at).getTime();
      if (!Number.isFinite(started) || started < Date.now() - 30 * 60_000) continue;
      checked += 1;
      const send = await fetch(new URL("/api/nivo-quarantine", request.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "announce", machineId: row.machine_id, clientId: row.client_id,
          triggeredAt: row.last_error_at,
          blockedUntil: new Date(started + 30 * 60_000).toISOString(),
          requestCount1m: Number(row.request_count_1m || 0),
        }),
        cache: "no-store",
      });
      if (!send.ok) failed += 1;
    }
    return NextResponse.json({ ok: true, checked, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ismeretlen hiba" }, { status: 503 });
  }
}
