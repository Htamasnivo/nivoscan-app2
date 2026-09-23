import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// app/api/nivo-quarantine/route.ts
// A Supabase SERVICE ROLE kulcs és a Resend API kulcs kizárólag szerveroldali ENV!
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hghvhsrjfwvaafkfhiyj.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.NIVO_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TABLE_EVENTS = "nivo_quarantine_events";
const TABLE_SETTINGS = "nivo_quarantine_notification_settings";
const TABLE_ACTIVITY = "nivo_machine_activity";
const EMAIL_FROM = process.env.REPORT_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || "";
const MAX_RECIPIENTS = 20;

interface Settings { id: number; enabled: boolean; recipients: string[]; panel_color: string; updated_at?: string }
interface EventRow {
  id: number;
  event_key: string;
  machine_id: string;
  client_id: string;
  triggered_at: string;
  blocked_until: string;
  reason: string;
  request_count_1m: number;
  email_claimed_at: string | null;
  email_sent_at: string | null;
  email_skipped_at: string | null;
  released_at: string | null;
}

const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
const clean = (value: unknown, limit = 200) => String(value ?? "").trim().slice(0, limit);
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const eventKey = (clientId: string, triggeredAt: string) => `${clientId}:${new Date(triggeredAt).toISOString()}`;
const isValidTime = (value: string) => Number.isFinite(Date.parse(value));

function requireConfig(): void {
  if (!SERVICE_KEY) throw new Error("Hiányzik a NIVO_SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY környezeti változó.");
}
function requireAdminPin(pin: unknown): void {
  const expected = process.env.NIVO_ADMIN_PIN || "";
  if (!expected) throw Object.assign(new Error("A NIVO_ADMIN_PIN nincs beállítva."), { status: 503 });
  if (clean(pin, 200) !== expected) throw Object.assign(new Error("Hibás admin PIN."), { status: 401 });
}
async function db(path: string, init: RequestInit = {}): Promise<any> {
  requireConfig();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const body = await response.text();
  const result = body ? JSON.parse(body) : null;
  if (!response.ok) throw Object.assign(new Error(clean(result?.message || body || `Supabase HTTP ${response.status}`, 400)), { status: 502 });
  return result;
}
const settings = async (): Promise<Settings> => {
  const rows = await db(`${TABLE_SETTINGS}?id=eq.1&select=id,enabled,recipients,panel_color,updated_at&limit=1`);
  return rows?.[0] || { id: 1, enabled: false, recipients: [], panel_color: "#16a34a" };
};
const publicSettings = (row: Settings) => ({
  enabled: !!row.enabled,
  recipients: row.recipients || [],
  panelColor: row.panel_color || "#16a34a",
});
const getEvent = async (key: string): Promise<EventRow | null> => {
  const rows = await db(`${TABLE_EVENTS}?event_key=eq.${encodeURIComponent(key)}&select=*&limit=1`);
  return rows?.[0] || null;
};

async function notifyOnce(row: EventRow): Promise<{ done: boolean; sent: boolean; skipped?: boolean }> {
  if (row.email_sent_at || row.email_skipped_at) return { done: true, sent: !!row.email_sent_at, skipped: !!row.email_skipped_at };
  const config = await settings();
  if (!config.enabled) {
    await db(`${TABLE_EVENTS}?id=eq.${row.id}&email_sent_at=is.null&email_skipped_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ email_skipped_at: new Date().toISOString(), email_error: null }),
    });
    return { done: true, sent: false, skipped: true };
  }
  if (!config.recipients?.length) throw new Error("A karanténértesítés aktív, de nincs címzett megadva.");
  if (!process.env.RESEND_API_KEY || !EMAIL_FROM) throw new Error("A Resend API kulcs vagy a feladó e-mail-cím hiányzik a Vercel ENV-ből.");

  // Kizárólag az egyik párhuzamos kérés foglalhatja le ezt az eseményt.
  // Három perc után újrafoglalható a félbeszakadt küldés.
  const expired = new Date(Date.now() - 3 * 60_000).toISOString();
  const claimed = await db(
    `${TABLE_EVENTS}?id=eq.${row.id}&email_sent_at=is.null&email_skipped_at=is.null&or=(email_claimed_at.is.null,email_claimed_at.lt.${encodeURIComponent(expired)})&select=id`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ email_claimed_at: new Date().toISOString(), email_error: null }) }
  );
  if (!claimed?.length) {
    const latest = await getEvent(row.event_key);
    return { done: !!(latest?.email_sent_at || latest?.email_skipped_at), sent: !!latest?.email_sent_at };
  }

  try {
    const time = new Date(row.triggered_at).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
    const until = new Date(row.blocked_until).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        // A Resend idempotency megakadályozza az ismételt levélküldést, ha a HTTP-válasz elveszik.
        "Idempotency-Key": `nivo-quarantine-${row.id}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: config.recipients,
        subject: `NÍVÓ – automatikus karantén: ${clean(row.machine_id, 100)}`,
        text: `Automatikus karanténba került egy munkaállomás.\n\nMunkaállomás: ${row.machine_id}\nIdőpont: ${time}\nKiváltó terhelés: ${row.request_count_1m} kérés/perc\nOk: ${row.reason}\nAutomatikus feloldás: ${until}\n\nKézi feloldás: NÍVÓ Admin > Automatikus karanténban lévő gépek.`,
      }),
      cache: "no-store",
    });
    const providerResult = await response.text();
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}: ${clean(providerResult, 300)}`);
    await db(`${TABLE_EVENTS}?id=eq.${row.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ email_sent_at: new Date().toISOString(), email_claimed_at: null, email_error: null }),
    });
    return { done: true, sent: true };
  } catch (error) {
    await db(`${TABLE_EVENTS}?id=eq.${row.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ email_claimed_at: null, email_error: clean(error instanceof Error ? error.message : error, 500) }),
    }).catch(() => undefined);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") || "active";
    if (scope === "appearance") {
      // A panelszín nem titkos beállítás; a címzettek és az e-mail kapcsoló
      // kizárólag Admin PIN-nel kérdezhetők le.
      const value = await settings();
      return reply({ panelColor: value.panel_color || "#16a34a" });
    }
    if (scope === "release-status") {
      const clientId = clean(url.searchParams.get("clientId"), 120);
      const triggeredAt = clean(url.searchParams.get("triggeredAt"), 60);
      if (!clientId || !isValidTime(triggeredAt)) return reply({ error: "Hiányos eseményazonosító." }, 400);
      const row = await getEvent(eventKey(clientId, triggeredAt));
      return reply({ registered: !!row, released: !!row?.released_at });
    }
    if (scope !== "active") return reply({ error: "Ismeretlen lekérdezés." }, 400);
    const now = new Date().toISOString();
    const rows = (await db(
      `${TABLE_EVENTS}?blocked_until=gt.${encodeURIComponent(now)}&released_at=is.null&select=id,machine_id,client_id,triggered_at,blocked_until,reason,request_count_1m,email_sent_at,email_skipped_at,email_error&order=triggered_at.desc&limit=100`
    )) || [];
    const released = (await db(
      `${TABLE_EVENTS}?released_at=not.is.null&released_at=gt.${encodeURIComponent(new Date(Date.now() - 60 * 60_000).toISOString())}&select=event_key,machine_id,client_id,triggered_at&limit=100`
    )) || [];
    return reply({ active: rows, recentReleased: released });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, Number((error as { status?: number })?.status || 503));
  }
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(input.action, 60);
    if (action === "read-settings") {
      requireAdminPin(input.pin);
      return reply({ settings: publicSettings(await settings()) });
    }
    if (action === "save-settings") {
      requireAdminPin(input.pin);
      const enabled = input.enabled === true;
      const recipients = Array.from(new Set(
        (Array.isArray(input.recipients) ? input.recipients : [])
          .map((value) => clean(value, 200).toLowerCase()).filter(Boolean)
      ));
      if (recipients.length > MAX_RECIPIENTS || recipients.some((value) => !validEmail(value))) {
        return reply({ error: `Legfeljebb ${MAX_RECIPIENTS} érvényes e-mail-cím állítható be.` }, 400);
      }
      if (enabled && recipients.length === 0) return reply({ error: "Aktív értesítéshez legalább egy e-mail-cím szükséges." }, 400);
      const panelColor = clean(input.panelColor || "#16a34a", 7);
      if (!/^#[0-9a-f]{6}$/i.test(panelColor)) return reply({ error: "Érvénytelen panel-színkód." }, 400);
      const rows = await db(`${TABLE_SETTINGS}?on_conflict=id&select=*`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ id: 1, enabled, recipients, panel_color: panelColor, updated_at: new Date().toISOString() }),
      });
      return reply({ settings: publicSettings(rows?.[0] || { id: 1, enabled, recipients, panel_color: panelColor }) });
    }
    if (action === "release" || action === "release-local") {
      requireAdminPin(input.pin);
      const identifier = Number(input.eventId || 0);
      const key = clean(input.eventKey, 240);
      const clause = identifier > 0 ? `id=eq.${identifier}` : key ? `event_key=eq.${encodeURIComponent(key)}` : "";
      if (!clause) return reply({ error: "Hiányzik a karanténesemény azonosítója." }, 400);
      const now = new Date().toISOString();
      const releasedRows = await db(`${TABLE_EVENTS}?${clause}&released_at=is.null&select=id,machine_id,triggered_at`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ released_at: now, released_by: clean(input.updatedBy || "Admin", 100) }),
      });
      return reply({ ok: true, released: !!releasedRows?.length });
    }
    if (action !== "announce") return reply({ error: "Ismeretlen művelet." }, 400);

    const machineId = clean(input.machineId, 100);
    const clientId = clean(input.clientId, 120);
    const triggeredAt = clean(input.triggeredAt, 60);
    const blockedUntil = clean(input.blockedUntil, 60);
    const count = Number(input.requestCount1m || 0);
    if (!machineId || !clientId || !isValidTime(triggeredAt) || !isValidTime(blockedUntil) || !Number.isFinite(count) || count < 0 || count > 1_000_000) {
      return reply({ error: "Érvénytelen karanténesemény." }, 400);
    }
    const t = new Date(triggeredAt).getTime();
    if (t < Date.now() - 30 * 60_000 || t > Date.now() + 60_000) return reply({ error: "Lejárt vagy jövőbeli karanténesemény." }, 400);

    // A nyilvános announce végpont nem küldhet levelet pusztán egy kliens által
    // bemondott gépnév alapján. A szerver ellenőrzi a gép utolsó heartbeatjét.
    const activity = (await db(
      `${TABLE_ACTIVITY}?machine_id=eq.${encodeURIComponent(machineId)}&select=machine_id,client_id,last_error,last_error_at&limit=1`
    ))?.[0] as { client_id?: string; last_error?: string; last_error_at?: string } | undefined;
    if (!activity || activity.client_id !== clientId || !String(activity.last_error || "").startsWith("AUTOMATIKUS VÉDELEM:")
      || Math.abs(Date.parse(activity.last_error_at || "") - t) > 10_000) {
      return reply({ error: "A gép karanténját a heartbeat még nem igazolta. A kliens újrapróbálja." }, 409);
    }

    const key = eventKey(clientId, triggeredAt);
    await db(`${TABLE_EVENTS}?on_conflict=event_key`, {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        event_key: key, machine_id: machineId, client_id: clientId,
        triggered_at: new Date(triggeredAt).toISOString(), blocked_until: new Date(blockedUntil).toISOString(),
        reason: clean(activity.last_error, 500), request_count_1m: count,
      }),
    });
    const row = await getEvent(key);
    if (!row) throw new Error("A karanténesemény nem tárolódott.");
    // Már kézzel feloldott eseményről ne küldjünk utólag riasztást.
    if (row.released_at) return reply({ ok: true, emailSent: false, released: true });
    const result = await notifyOnce(row);
    return reply({ ok: result.done, emailSent: result.sent, emailSkipped: result.skipped || false }, result.done ? 200 : 202);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, Number((error as { status?: number })?.status || 503));
  }
}
