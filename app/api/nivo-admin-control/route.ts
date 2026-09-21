import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REDIS_URL = (
  process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_URL
  || process.env.REDIS_REST_URL
  || ""
).replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.KV_REST_API_TOKEN
  || process.env.REDIS_REST_TOKEN
  || "";
const ADMIN_PIN = process.env.NIVO_ADMIN_PIN || "";

const KEY_MACHINES = "nivo:admin:machines";
const KEY_GLOBAL_DISABLED = "nivo:admin:global-disabled";
const MACHINE_PREFIX = "nivo:admin:machine:";
const HISTORY_PREFIX = "nivo:admin:history:";
const CONTROL_PREFIX = "nivo:admin:control:";
const SESSION_PREFIX = "nivo:admin:session:";

const HEARTBEAT_TTL_SECONDS = 90;
const HISTORY_TTL_SECONDS = 2 * 60 * 60;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const HISTORY_LIMIT = 720; // 1 óra 5 másodperces mintákkal.

type ActivityRequest = {
  at?: string;
  method?: string;
  target?: string;
  status?: number;
  durationMs?: number;
  ok?: boolean;
  error?: string;
};

type ActivityWindow = {
  windowStartedAt?: string;
  total?: number;
  errors?: number;
  methods?: Record<string, number>;
  statuses?: Record<string, number>;
  activeRequests?: number;
  lastSuccessAt?: string;
  lastError?: string;
  recentRequests?: ActivityRequest[];
};

type HeartbeatPayload = {
  machineId: string;
  page: string;
  workerName: string;
  activity: ActivityWindow;
  lastSeenAt: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function sanitizeMachineId(value: unknown): string {
  const text = String(value ?? "").trim().slice(0, 96);
  return text || "Ismeretlen gép";
}

function safeRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const num = Number(raw || 0);
    if (Number.isFinite(num) && num >= 0) out[String(key).slice(0, 40)] = Math.floor(num);
  }
  return out;
}

function normalizeRecentRequests(value: unknown): ActivityRequest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((raw) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      at: String(item.at || "").slice(0, 40),
      method: String(item.method || "GET").slice(0, 12),
      target: String(item.target || "").slice(0, 420),
      status: Math.max(0, Math.min(999, Number(item.status || 0))),
      durationMs: Math.max(0, Math.min(600_000, Math.round(Number(item.durationMs || 0)))),
      ok: Boolean(item.ok),
      error: String(item.error || "").slice(0, 500),
    };
  });
}

async function redis(command: Array<string | number>): Promise<unknown> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("A Vercel/Upstash Redis nincs beállítva. Add meg az UPSTASH_REDIS_REST_URL és UPSTASH_REDIS_REST_TOKEN környezeti változókat.");
  }
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { result?: unknown; error?: string };
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis HTTP ${response.status}`);
  }
  return payload.result;
}

async function readBool(key: string): Promise<boolean> {
  const value = await redis(["GET", key]);
  return String(value || "0") === "1";
}

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const valid = await redis(["GET", `${SESSION_PREFIX}${token}`]);
  return valid ? token : null;
}

function sumMaps(target: Record<string, number>, source: Record<string, number>) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + Number(value || 0);
}

function emptyCountSet() {
  return { oneMinute: 0, fiveMinutes: 0, oneHour: 0 };
}

async function handleHeartbeat(body: Record<string, unknown>) {
  const machineId = sanitizeMachineId(body.machineId);
  const activityRaw = body.activity && typeof body.activity === "object" ? body.activity as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const activity: ActivityWindow = {
    windowStartedAt: String(activityRaw.windowStartedAt || now).slice(0, 40),
    total: Math.max(0, Math.floor(Number(activityRaw.total || 0))),
    errors: Math.max(0, Math.floor(Number(activityRaw.errors || 0))),
    methods: safeRecord(activityRaw.methods),
    statuses: safeRecord(activityRaw.statuses),
    activeRequests: Math.max(0, Math.floor(Number(activityRaw.activeRequests || 0))),
    lastSuccessAt: String(activityRaw.lastSuccessAt || "").slice(0, 40),
    lastError: String(activityRaw.lastError || "").slice(0, 500),
    recentRequests: normalizeRecentRequests(activityRaw.recentRequests),
  };
  const current: HeartbeatPayload = {
    machineId,
    page: String(body.page || "").slice(0, 120),
    workerName: String(body.workerName || "").slice(0, 160),
    activity,
    lastSeenAt: now,
  };
  const historyItem = JSON.stringify({
    at: now,
    total: activity.total || 0,
    errors: activity.errors || 0,
    methods: activity.methods || {},
    statuses: activity.statuses || {},
  });

  await Promise.all([
    redis(["SADD", KEY_MACHINES, machineId]),
    redis(["SET", `${MACHINE_PREFIX}${machineId}`, JSON.stringify(current), "EX", HEARTBEAT_TTL_SECONDS]),
    redis(["LPUSH", `${HISTORY_PREFIX}${machineId}`, historyItem]),
  ]);
  await Promise.all([
    redis(["LTRIM", `${HISTORY_PREFIX}${machineId}`, 0, HISTORY_LIMIT - 1]),
    redis(["EXPIRE", `${HISTORY_PREFIX}${machineId}`, HISTORY_TTL_SECONDS]),
  ]);

  const [globalDisabled, machineDisabled] = await Promise.all([
    readBool(KEY_GLOBAL_DISABLED),
    readBool(`${CONTROL_PREFIX}${machineId}`),
  ]);
  return NextResponse.json({
    ok: true,
    disabled: globalDisabled || machineDisabled,
    globalDisabled,
    machineDisabled,
    serverTime: now,
  });
}

async function buildSnapshot() {
  const rawMembers = await redis(["SMEMBERS", KEY_MACHINES]);
  const machineIds = Array.isArray(rawMembers) ? rawMembers.map((value) => sanitizeMachineId(value)) : [];
  const globalDisabled = await readBool(KEY_GLOBAL_DISABLED);
  const now = Date.now();

  const machines = await Promise.all(machineIds.map(async (machineId) => {
    const [currentRaw, disabled, historyRaw] = await Promise.all([
      redis(["GET", `${MACHINE_PREFIX}${machineId}`]),
      readBool(`${CONTROL_PREFIX}${machineId}`),
      redis(["LRANGE", `${HISTORY_PREFIX}${machineId}`, 0, HISTORY_LIMIT - 1]),
    ]);

    let current: HeartbeatPayload | null = null;
    if (currentRaw) {
      try { current = JSON.parse(String(currentRaw)) as HeartbeatPayload; } catch { current = null; }
    }
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    const counts = emptyCountSet();
    const errors = emptyCountSet();
    const methods: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    let inferredLastSeenAt = current?.lastSeenAt || "";

    for (const raw of history) {
      try {
        const item = JSON.parse(String(raw)) as { at?: string; total?: number; errors?: number; methods?: Record<string, number>; statuses?: Record<string, number> };
        const time = new Date(String(item.at || "")).getTime();
        if (!Number.isFinite(time)) continue;
        if (!inferredLastSeenAt) inferredLastSeenAt = String(item.at || "");
        const age = now - time;
        const total = Math.max(0, Number(item.total || 0));
        const err = Math.max(0, Number(item.errors || 0));
        if (age <= 60_000) { counts.oneMinute += total; errors.oneMinute += err; }
        if (age <= 5 * 60_000) { counts.fiveMinutes += total; errors.fiveMinutes += err; }
        if (age <= 60 * 60_000) {
          counts.oneHour += total;
          errors.oneHour += err;
          sumMaps(methods, safeRecord(item.methods));
          sumMaps(statuses, safeRecord(item.statuses));
        }
      } catch { /* hibás history elemet kihagyjuk */ }
    }

    const lastSeenMs = inferredLastSeenAt ? new Date(inferredLastSeenAt).getTime() : 0;
    const online = Boolean(lastSeenMs && now - lastSeenMs <= HEARTBEAT_TTL_SECONDS * 1000);
    return {
      machineId,
      disabled: Boolean(globalDisabled || disabled),
      machineDisabled: disabled,
      online,
      lastSeenAt: inferredLastSeenAt,
      lastSuccessAt: current?.activity?.lastSuccessAt || "",
      lastError: current?.activity?.lastError || "",
      page: current?.page || "",
      workerName: current?.workerName || "",
      activeRequests: current?.activity?.activeRequests || 0,
      counts,
      errors,
      methods,
      statuses,
      recentRequests: current?.activity?.recentRequests || [],
    };
  }));

  machines.sort((a, b) => Number(b.online) - Number(a.online) || a.machineId.localeCompare(b.machineId, "hu"));
  return { ok: true, globalDisabled, generatedAt: new Date().toISOString(), machines };
}

export async function GET(request: NextRequest) {
  try {
    const token = await requireAdmin(request);
    if (!token) return jsonError("Érvénytelen vagy lejárt admin munkamenet.", 401);
    return NextResponse.json(await buildSnapshot(), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "heartbeat") return await handleHeartbeat(body);

    if (action === "login") {
      if (!ADMIN_PIN) return jsonError("A NIVO_ADMIN_PIN Vercel környezeti változó nincs beállítva.", 503);
      const pin = String(body.pin || "");
      if (!pin || pin !== ADMIN_PIN) return jsonError("Hibás admin PIN.", 401);
      const token = crypto.randomUUID().replace(/-/g, "");
      await redis(["SET", `${SESSION_PREFIX}${token}`, "1", "EX", SESSION_TTL_SECONDS]);
      return NextResponse.json({ ok: true, token, expiresInSeconds: SESSION_TTL_SECONDS });
    }

    const token = await requireAdmin(request);
    if (!token) return jsonError("Érvénytelen vagy lejárt admin munkamenet.", 401);

    if (action === "set-machine-disabled") {
      const machineId = sanitizeMachineId(body.machineId);
      const disabled = Boolean(body.disabled);
      await redis(["SET", `${CONTROL_PREFIX}${machineId}`, disabled ? "1" : "0"]);
      return NextResponse.json({ ok: true, machineId, disabled });
    }

    if (action === "set-global-disabled") {
      const disabled = Boolean(body.disabled);
      await redis(["SET", KEY_GLOBAL_DISABLED, disabled ? "1" : "0"]);
      return NextResponse.json({ ok: true, globalDisabled: disabled });
    }

    if (action === "enable-all") {
      await redis(["SET", KEY_GLOBAL_DISABLED, "0"]);
      const rawMembers = await redis(["SMEMBERS", KEY_MACHINES]);
      const machineIds = Array.isArray(rawMembers) ? rawMembers.map((value) => sanitizeMachineId(value)) : [];
      await Promise.all(machineIds.map((machineId) => redis(["SET", `${CONTROL_PREFIX}${machineId}`, "0"])));
      return NextResponse.json({ ok: true, globalDisabled: false, enabledMachines: machineIds.length });
    }

    return jsonError("Ismeretlen admin művelet.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 503);
  }
}
