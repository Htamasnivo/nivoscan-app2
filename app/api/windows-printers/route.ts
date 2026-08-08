import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function GET() {
  if (process.platform !== "win32") {
    return NextResponse.json(
      {
        printers: [],
        error: "A Windows nyomtatólista csak Windows alatt futó Next.js szerveren kérdezhető le.",
      },
      { status: 500 }
    );
  }

  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$items = Get-Printer | Sort-Object Name | Select-Object -ExpandProperty Name",
      "if ($null -eq $items) { '[]' } else { @($items) | ConvertTo-Json -Compress }",
    ].join("; ");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );

    const raw = stdout.trim();
    const decoded = raw ? JSON.parse(raw) : [];
    const printers = (Array.isArray(decoded) ? decoded : [decoded])
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    return NextResponse.json({ printers });
  } catch (error) {
    console.error("Windows printer list error:", error);
    return NextResponse.json(
      {
        printers: [],
        error: error instanceof Error ? error.message : "Nem sikerült lekérni a Windows nyomtatókat.",
      },
      { status: 500 }
    );
  }
}

