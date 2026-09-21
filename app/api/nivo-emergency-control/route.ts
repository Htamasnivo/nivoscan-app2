import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONTROL_KEY = "nivo-emergency-control";

type EmergencyControl = {
  globalStop: boolean;
  disabledMachines: Record<string, boolean>;
  updatedAt: string;
  updatedBy: string;
};

function defaultControl(): EmergencyControl {
  return {
    globalStop: false,
    disabledMachines: {},
    updatedAt: "",
    updatedBy: "",
  };
}

function env() {
  return {
    configId: String(process.env.NIVO_GLOBAL_CONFIG_ID || "").trim(),
    readToken: String(process.env.NIVO_GLOBAL_CONFIG_READ_TOKEN || "").trim(),
    vercelToken: String(process.env.VERCEL_ACCESS_TOKEN || "").trim(),
    teamId: String(process.env.VERCEL_TEAM_ID || "").trim(),
    adminPin: String(process.env.NIVO_ADMIN_PIN || "").trim(),
  };
}

function sanitizeControl(value: unknown): EmergencyControl {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawDisabled = source.disabledMachines && typeof source.disabledMachines === "object"
    ? source.disabledMachines as Record<string, unknown>
    : {};
  const disabledMachines: Record<string, boolean> = {};
  Object.entries(rawDisabled).forEach(([key, disabled]) => {
    const clean = String(key || "").trim().slice(0, 200);
    if (clean && Boolean(disabled)) disabledMachines[clean] = true;
  });
  return {
    globalStop: Boolean(source.globalStop),
    disabledMachines,
    updatedAt: String(source.updatedAt || ""),
    updatedBy: String(source.updatedBy || "").slice(0, 200),
  };
}

async function readControl(): Promise<{ configured: boolean; value: EmergencyControl; error?: string }> {
  const settings = env();
  if (!settings.configId || !settings.readToken) {
    return {
      configured: false,
      value: defaultControl(),
      error: "A Vercel Global Config nincs beállítva (NIVO_GLOBAL_CONFIG_ID / NIVO_GLOBAL_CONFIG_READ_TOKEN).",
    };
  }

  const url = `https://edge-config.vercel.com/${encodeURIComponent(settings.configId)}/item/${encodeURIComponent(CONTROL_KEY)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.readToken}` },
      cache: "no-store",
    });
    if (response.status === 404) return { configured: true, value: defaultControl() };
    if (!response.ok) {
      return {
        configured: true,
        value: defaultControl(),
        error: `Global Config olvasási hiba: HTTP ${response.status}`,
      };
    }
    const json = await response.json();
    return { configured: true, value: sanitizeControl(json) };
  } catch (error) {
    return {
      configured: true,
      value: defaultControl(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeControl(value: EmergencyControl): Promise<void> {
  const settings = env();
  if (!settings.configId || !settings.vercelToken) {
    throw new Error("A Global Config írás nincs beállítva (NIVO_GLOBAL_CONFIG_ID / VERCEL_ACCESS_TOKEN).");
  }

  const query = settings.teamId ? `?teamId=${encodeURIComponent(settings.teamId)}` : "";
  const response = await fetch(
    `https://api.vercel.com/v1/edge-config/${encodeURIComponent(settings.configId)}/items${query}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${settings.vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            operation: "upsert",
            key: CONTROL_KEY,
            value,
          },
        ],
      }),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Global Config írási hiba: HTTP ${response.status}${detail ? ` – ${detail.slice(0, 300)}` : ""}`);
  }
}

export async function GET() {
  const current = await readControl();
  return NextResponse.json(
    {
      configured: current.configured,
      ...current.value,
      ...(current.error ? { error: current.error } : {}),
    },
    {
      status: 200,
      headers: {
        // Több terminál ugyanazt a vészállapotot olvassa. A rövid CDN-cache csökkenti
        // a Vercel Function terhelést, miközben a leállítás 5 mp-en belül eljut a kliensekhez.
        "Cache-Control": "public, s-maxage=2, stale-while-revalidate=2",
      },
    }
  );
}

export async function POST(request: NextRequest) {
  const settings = env();
  if (!settings.adminPin) {
    return NextResponse.json({ error: "NIVO_ADMIN_PIN nincs beállítva a Vercel környezeti változók között." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({})) as {
    pin?: string;
    action?: string;
    value?: boolean;
    machineId?: string;
    updatedBy?: string;
  };

  if (String(body.pin || "") !== settings.adminPin) {
    return NextResponse.json({ error: "Hibás admin PIN." }, { status: 401 });
  }

  const current = await readControl();
  if (!current.configured) {
    return NextResponse.json({ error: current.error || "A Vercel Global Config nincs beállítva." }, { status: 503 });
  }
  if (current.error) {
    return NextResponse.json({ error: current.error }, { status: 503 });
  }

  const next = sanitizeControl(current.value);
  const action = String(body.action || "");
  if (action === "set-global-stop") {
    next.globalStop = Boolean(body.value);
  } else if (action === "set-machine-stop") {
    const machineId = String(body.machineId || "").trim().slice(0, 200);
    if (!machineId) return NextResponse.json({ error: "Hiányzik a machineId." }, { status: 400 });
    if (Boolean(body.value)) next.disabledMachines[machineId] = true;
    else delete next.disabledMachines[machineId];
  } else {
    return NextResponse.json({ error: "Ismeretlen vészvezérlési művelet." }, { status: 400 });
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = String(body.updatedBy || "Admin").trim().slice(0, 200) || "Admin";

  try {
    await writeControl(next);
    return NextResponse.json({ configured: true, ...next }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
