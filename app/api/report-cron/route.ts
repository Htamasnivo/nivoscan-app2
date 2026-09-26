import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium } from "playwright-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function getSecret(): string {
  return String(process.env.REPORT_CRON_SECRET || process.env.CRON_SECRET || "").trim();
}

function sign(secret: string, timestamp: string): string {
  return createHmac("sha256", secret).update(timestamp).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isFreshTimestamp(raw: string): boolean {
  const value = Number(raw);
  if (!Number.isFinite(value)) return false;
  return Math.abs(Date.now() - value) <= 2 * 60 * 1000;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = getSecret();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Hiányzik a REPORT_CRON_SECRET vagy CRON_SECRET Vercel környezeti változó." },
      { status: 500 }
    );
  }

  const mode = request.nextUrl.searchParams.get("mode") || "";

  // Ezt a headless böngészőből betöltött page.tsx használja.
  if (mode === "validate") {
    const ts = request.nextUrl.searchParams.get("ts") || "";
    const sig = request.nextUrl.searchParams.get("sig") || "";
    const valid = isFreshTimestamp(ts) && safeEqual(sig, sign(secret, ts));
    return NextResponse.json({ ok: valid }, { status: valid ? 200 : 401 });
  }

  // Vercel Cron a CRON_SECRET-et Authorization: Bearer ... fejlécben küldi.
  const authorization = String(request.headers.get("authorization") || "");
  const expectedAuthorization = `Bearer ${secret}`;
  if (!safeEqual(authorization, expectedAuthorization)) {
    return NextResponse.json({ ok: false, error: "Jogosulatlan cron kérés." }, { status: 401 });
  }

  const timestamp = String(Date.now());
  const signature = sign(secret, timestamp);
  const targetUrl = new URL("/", request.nextUrl.origin);
  targetUrl.searchParams.set("view", "report-cron");
  targetUrl.searchParams.set("ts", timestamp);
  targetUrl.searchParams.set("sig", signature);

  let browser: Awaited<ReturnType<typeof playwrightChromium.launch>> | null = null;
  try {
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const context = await browser.newContext({
      timezoneId: "Europe/Budapest",
      locale: "hu-HU",
    });
    const page = await context.newPage();

    await page.goto(targetUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 40_000,
    });

    await page.waitForFunction(
      () => (window as typeof window & { __NIVO_REPORT_CRON_DONE__?: boolean }).__NIVO_REPORT_CRON_DONE__ === true,
      undefined,
      { timeout: 50_000 }
    );

    const clientError = await page.evaluate(
      () => (window as typeof window & { __NIVO_REPORT_CRON_ERROR__?: string }).__NIVO_REPORT_CRON_ERROR__ || ""
    );

    await context.close();

    if (clientError) {
      return NextResponse.json({ ok: false, error: clientError }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      timezone: "Europe/Budapest",
    });
  } catch (error) {
    console.error("/api/report-cron hiba:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Ismeretlen riport-cron hiba." },
      { status: 500 }
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
