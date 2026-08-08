import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type PrintField = {
  key: string;
  label: string;
  visible?: boolean;
  x?: number;
  y?: number;
  width?: number;
  fontSize?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
};

type PrintTemplate = {
  widthMm: number;
  heightMm: number;
  fields: PrintField[];
};

type PrintJob = {
  title?: string;
  data?: Record<string, string>;
};

type RequestBody = {
  printerName?: string;
  template?: PrintTemplate;
  jobs?: PrintJob[];
};

const POWERSHELL_PRINT_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$printerName = [string]$config.printerName
$template = $config.template
$jobs = @($config.jobs)

if ([string]::IsNullOrWhiteSpace($printerName)) { throw 'Nincs megadva nyomtató.' }
if ($jobs.Count -eq 0) { throw 'Nincs nyomtatási feladat.' }

$widthMm = [double]$template.widthMm
$heightMm = [double]$template.heightMm
if ($widthMm -le 0 -or $heightMm -le 0) { throw 'Érvénytelen címkeméret.' }

$widthHi = [Math]::Max(1, [int][Math]::Round(($widthMm / 25.4) * 100.0))
$heightHi = [Math]::Max(1, [int][Math]::Round(($heightMm / 25.4) * 100.0))

foreach ($job in $jobs) {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  try {
    $doc.PrinterSettings.PrinterName = $printerName
    if (-not $doc.PrinterSettings.IsValid) { throw "A megadott nyomtató nem érhető el: $printerName" }

    $paper = New-Object System.Drawing.Printing.PaperSize('NIVO_CUSTOM', $widthHi, $heightHi)
    $doc.DefaultPageSettings.PaperSize = $paper
    $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    $doc.OriginAtMargins = $false
    $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
    $doc.DocumentName = if ([string]::IsNullOrWhiteSpace([string]$job.title)) { 'NIVO címke' } else { [string]$job.title }

    $handler = [System.Drawing.Printing.PrintPageEventHandler]{
      param($sender, $e)
      $graphics = $e.Graphics
      $pageWidth = [single]$e.PageBounds.Width
      $pageHeight = [single]$e.PageBounds.Height
      $graphics.Clear([System.Drawing.Color]::White)

      $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 0.7)
      try { $graphics.DrawRectangle($borderPen, 1, 1, [Math]::Max(1, $pageWidth - 2), [Math]::Max(1, $pageHeight - 2)) } finally { $borderPen.Dispose() }

      $titleText = [string]$job.title
      if (-not [string]::IsNullOrWhiteSpace($titleText)) {
        $titleFont = New-Object System.Drawing.Font('Arial', 8.5, [System.Drawing.FontStyle]::Bold)
        $titleFormat = New-Object System.Drawing.StringFormat
        try {
          $titleFormat.Alignment = [System.Drawing.StringAlignment]::Center
          $titleFormat.LineAlignment = [System.Drawing.StringAlignment]::Near
          $titleRect = New-Object System.Drawing.RectangleF(2, 1, [Math]::Max(1, $pageWidth - 4), [Math]::Max(1, $pageHeight * 0.13))
          $graphics.DrawString($titleText, $titleFont, [System.Drawing.Brushes]::Black, $titleRect, $titleFormat)
        } finally {
          $titleFormat.Dispose()
          $titleFont.Dispose()
        }
      }

      foreach ($field in @($template.fields)) {
        if ($field.visible -eq $false) { continue }
        $key = [string]$field.key
        $label = [string]$field.label
        $value = ''
        if ($null -ne $job.data -and $job.data.PSObject.Properties.Name -contains $key) {
          $value = [string]$job.data.PSObject.Properties[$key].Value
        }
        if ([string]::IsNullOrWhiteSpace($value)) { $value = '-' }
        $text = if ([string]::IsNullOrWhiteSpace($label)) { $value } else { "$($label): $value" }

        $fontSize = [single]([Math]::Max(5.0, [double]$field.fontSize))
        $fontStyle = if ($field.bold -eq $true) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
        $font = New-Object System.Drawing.Font('Arial', $fontSize, $fontStyle)
        $format = New-Object System.Drawing.StringFormat
        try {
          switch ([string]$field.align) {
            'center' { $format.Alignment = [System.Drawing.StringAlignment]::Center }
            'right'  { $format.Alignment = [System.Drawing.StringAlignment]::Far }
            default  { $format.Alignment = [System.Drawing.StringAlignment]::Near }
          }
          $format.LineAlignment = [System.Drawing.StringAlignment]::Near
          $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter

          $x = [single]($pageWidth * ([Math]::Max(0.0, [Math]::Min(95.0, [double]$field.x)) / 100.0))
          $y = [single]($pageHeight * ([Math]::Max(0.0, [Math]::Min(95.0, [double]$field.y)) / 100.0))
          $w = [single]($pageWidth * ([Math]::Max(5.0, [Math]::Min(100.0, [double]$field.width)) / 100.0))
          $h = [single]([Math]::Max(10.0, $pageHeight - $y - 1.0))
          $rect = New-Object System.Drawing.RectangleF($x, $y, [Math]::Min($w, $pageWidth - $x), $h)
          $graphics.DrawString($text, $font, [System.Drawing.Brushes]::Black, $rect, $format)
        } finally {
          $format.Dispose()
          $font.Dispose()
        }
      }
      $e.HasMorePages = $false
    }

    $doc.add_PrintPage($handler)
    try { $doc.Print() } finally { $doc.remove_PrintPage($handler) }
  } finally {
    $doc.Dispose()
  }
}
`;

export async function POST(request: Request) {
  if (process.platform !== "win32") {
    return NextResponse.json(
      { error: "A közvetlen Windows-nyomtatás csak Windows alatt futó Next.js szerveren használható." },
      { status: 500 }
    );
  }

  let configPath = "";
  let scriptPath = "";
  try {
    const body = (await request.json()) as RequestBody;
    const printerName = String(body?.printerName || "").trim();
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    const template = body?.template;

    if (!printerName) return NextResponse.json({ error: "Nincs kiválasztott nyomtató." }, { status: 400 });
    if (!template || !Number(template.widthMm) || !Number(template.heightMm) || !Array.isArray(template.fields)) {
      return NextResponse.json({ error: "Érvénytelen címkesablon." }, { status: 400 });
    }
    if (jobs.length === 0) return NextResponse.json({ error: "Nincs nyomtatandó címke." }, { status: 400 });

    const token = crypto.randomBytes(8).toString("hex");
    configPath = path.join(os.tmpdir(), `nivo-label-${token}.json`);
    scriptPath = path.join(os.tmpdir(), `nivo-label-${token}.ps1`);

    await fs.writeFile(configPath, JSON.stringify({ printerName, template, jobs }), "utf8");
    await fs.writeFile(scriptPath, POWERSHELL_PRINT_SCRIPT, "utf8");

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ConfigPath", configPath],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 120000 }
    );

    return NextResponse.json({ ok: true, printerName, printedCount: jobs.length });
  } catch (error) {
    console.error("Label print error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "A címkenyomtatás sikertelen." },
      { status: 500 }
    );
  } finally {
    await Promise.all([
      configPath ? fs.unlink(configPath).catch(() => undefined) : Promise.resolve(),
      scriptPath ? fs.unlink(scriptPath).catch(() => undefined) : Promise.resolve(),
    ]);
  }
}

