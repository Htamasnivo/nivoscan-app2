import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROOT = "P:\\Gyartas\\Termelesi_terv";
const DEFAULT_FILE_PATH = `${ALLOWED_ROOT}\\Napi_termelesi_terv.xlsx`;

function normalizeWindowsPath(value: unknown): string {
  const text = String(value || "").trim();
  return path.win32.normalize(text || DEFAULT_FILE_PATH);
}

function isInsideAllowedRoot(filePath: string): boolean {
  const normalizedRoot = path.win32.normalize(ALLOWED_ROOT).toLocaleLowerCase("hu");
  const normalizedFile = path.win32.normalize(filePath).toLocaleLowerCase("hu");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}\\`);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({})) as { path?: string };
    const requestedPath = normalizeWindowsPath(body.path);

    if (!isInsideAllowedRoot(requestedPath)) {
      return NextResponse.json(
        { error: `Biztonsági okból csak a(z) ${ALLOWED_ROOT} mappából olvasható Excel-fájl.` },
        { status: 403 }
      );
    }

    if (path.win32.extname(requestedPath).toLocaleLowerCase("hu") !== ".xlsx") {
      return NextResponse.json({ error: "A szerveres termelési terv csak .xlsx fájl lehet." }, { status: 400 });
    }

    const fileInfo = await stat(requestedPath);
    if (!fileInfo.isFile()) {
      return NextResponse.json({ error: "A megadott elérési út nem fájlra mutat." }, { status: 400 });
    }

    const fileBuffer = await readFile(requestedPath);
    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `inline; filename="${path.win32.basename(requestedPath)}"`,
        "Content-Length": String(fileBuffer.byteLength),
        "X-File-Modified-At": fileInfo.mtime.toISOString(),
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Szerveres termelési terv beolvasási hiba:", error);
    return NextResponse.json(
      {
        error: `A szerver nem tudta beolvasni az XLSX-fájlt. Ellenőrizd, hogy a Next.js szervert futtató Windows-felhasználó látja-e a P: meghajtót. Részletek: ${message}`,
      },
      { status: 500 }
    );
  }
}
