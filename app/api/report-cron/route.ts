import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { open, stat, unlink } from "fs/promises";
import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium } from "playwright-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;


const CHROMIUM_LAUNCH_LOCK_FILE = "/tmp/nivo-report-cron-chromium.lock";
const CHROMIUM_LAUNCH_LOCK_STALE_MS = 20_000;
const CHROMIUM_LAUNCH_LOCK_WAIT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEtxtbsyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const code = String((error as { code?: unknown } | null)?.code || "");
  return code === "ETXTBSY" || /ETXTBSY/i.test(message);
}

async function acquireChromiumLaunchLock(): Promise<() => Promise<void>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CHROMIUM_LAUNCH_LOCK_WAIT_MS) {
    try {
      const handle = await open(CHROMIUM_LAUNCH_LOCK_FILE, "wx");
      await handle.writeFile(`${process.pid}|${Date.now()}`);

      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(CHROMIUM_LAUNCH_LOCK_FILE).catch(() => undefined);
      };
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code || "");
      if (code !== "EEXIST") throw error;

      try {
        const lockStat = await stat(CHROMIUM_LAUNCH_LOCK_FILE);
        if (Date.now() - lockStat.mtimeMs > CHROMIUM_LAUNCH_LOCK_STALE_MS) {
          await unlink(CHROMIUM_LAUNCH_LOCK_FILE).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(250);
    }
  }

  throw new Error("A Chromium indítási zár 12 másodpercen belül nem szabadult fel.");
}

async function launchChromiumSafely() {
  const releaseLock = await acquireChromiumLaunchLock();
  try {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const executablePath = await chromium.executablePath();

        return await playwrightChromium.launch({
          args: chromium.args,
          executablePath,
          headless: true,
        });
      } catch (error) {
        lastError = error;
        if (!isEtxtbsyError(error) || attempt >= 5) throw error;

        // @sparticuz/chromium ugyanazt a /tmp/chromium fájlt bontja ki.
        // Párhuzamos Vercel invocation esetén rövid ideig ETXTBSY lehet.
        // Várunk, majd ugyanazzal a már externalizált binárissal újrapróbáljuk.
        await sleep(350 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("A Chromium nem indult el.");
  } finally {
    await releaseLock();
  }
}

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

  // FONTOS:
  // A Vercel Cron a konkrét, generált deployment hostot hívhatja
  // (pl. nivoscan-app2-...-nivoscanapp2.vercel.app), amely Vercel Authentication
  // mögött lehet. A headless böngészőnek viszont a projekt stabil PRODUCTION
  // domainjét kell megnyitnia.
  const productionHost = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  const targetOrigin = productionHost
    ? `https://${productionHost}`
    : request.nextUrl.origin;

  const targetUrl = new URL("/", targetOrigin);
  targetUrl.searchParams.set("view", "report-cron");
  targetUrl.searchParams.set("ts", timestamp);
  targetUrl.searchParams.set("sig", signature);

  // Ha a Production domain is Vercel Deployment Protection mögött van,
  // a Vercel által biztosított Automation Bypass secretet is használjuk.
  // Ha nincs ilyen secret konfigurálva, egyszerűen a publikus Production URL fut.
  const automationBypassSecret = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();

  let browser: Awaited<ReturnType<typeof playwrightChromium.launch>> | null = null;
  try {
    browser = await launchChromiumSafely();

    const context = await browser.newContext({
      timezoneId: "Europe/Budapest",
      locale: "hu-HU",
      ...(automationBypassSecret
        ? {
            extraHTTPHeaders: {
              "x-vercel-protection-bypass": automationBypassSecret,
              "x-vercel-set-bypass-cookie": "true",
            },
          }
        : {}),
    });
    const page = await context.newPage();

    const browserMessages: string[] = [];
    page.on("console", (message) => {
      const line = `[console:${message.type()}] ${message.text()}`.slice(0, 1000);
      browserMessages.push(line);
      if (browserMessages.length > 20) browserMessages.shift();
    });
    page.on("pageerror", (error) => {
      browserMessages.push(`[pageerror] ${error.message}`.slice(0, 1000));
      if (browserMessages.length > 20) browserMessages.shift();
    });

    await page.goto(targetUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    try {
      await page.waitForFunction(
        () => (window as typeof window & { __NIVO_REPORT_CRON_STARTED__?: boolean }).__NIVO_REPORT_CRON_STARTED__ === true,
        undefined,
        { timeout: 12_000 }
      );
    } catch {
      const diagnostic = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        body: document.body?.innerText?.slice(0, 1000) || "",
      })).catch(() => ({ url: "", title: "", body: "" }));
      throw new Error(
        `A riport-cron kliens nem indult el. Cél: ${targetUrl.origin}; végső URL: ${diagnostic.url}; ` +
        `title: ${diagnostic.title}; body: ${diagnostic.body}; ` +
        `Automation bypass: ${automationBypassSecret ? "igen" : "nem"}; ` +
        `Böngészőlog: ${browserMessages.join(" | ")}`
      );
    }

    try {
      await page.waitForFunction(
        () => (window as typeof window & { __NIVO_REPORT_CRON_DONE__?: boolean }).__NIVO_REPORT_CRON_DONE__ === true,
        undefined,
        { timeout: 42_000 }
      );
    } catch {
      const state = await page.evaluate(() => {
        const w = window as typeof window & {
          __NIVO_REPORT_CRON_STAGE__?: string;
          __NIVO_REPORT_CRON_ERROR__?: string;
        };
        return {
          stage: w.__NIVO_REPORT_CRON_STAGE__ || "ismeretlen",
          error: w.__NIVO_REPORT_CRON_ERROR__ || "",
        };
      }).catch(() => ({ stage: "nem olvasható", error: "" }));
      throw new Error(
        `A riport-cron nem fejeződött be időben. Aktuális szakasz: ${state.stage}. ` +
        `${state.error ? `Klienshiba: ${state.error}. ` : ""}` +
        `Böngészőlog: ${browserMessages.join(" | ")}`
      );
    }

    const clientState = await page.evaluate(() => {
      const w = window as typeof window & {
        __NIVO_REPORT_CRON_ERROR__?: string;
        __NIVO_REPORT_CRON_STAGE__?: string;
      };
      return {
        error: w.__NIVO_REPORT_CRON_ERROR__ || "",
        stage: w.__NIVO_REPORT_CRON_STAGE__ || "",
      };
    });

    await context.close();

    if (clientState.error) {
      return NextResponse.json(
        { ok: false, error: clientState.error, stage: clientState.stage, browserMessages },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      timezone: "Europe/Budapest",
      targetOrigin,
      automationBypassUsed: Boolean(automationBypassSecret),
      stage: clientState.stage,
      browserMessages,
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
