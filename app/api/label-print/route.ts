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

type LabelElement = {
  id: string;
  type: "field" | "staticText" | "line" | "box" | "filledBox" | "barcode" | "qrcode" | "image";
  key?: string;
  label?: string;
  text?: string;
  visible?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  fontFamily?: string;
  labelFontSize?: number;
  valueFontSize?: number;
  labelBold?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  stackedLabel?: boolean;
  wrap?: boolean;
  maxLines?: number;
  prefix?: string;
  suffix?: string;
  charSpacing?: number;
  rotation?: 0 | 90 | 180 | 270;
  textColor?: string;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  lineWidth?: number;
  hideWhenEmpty?: boolean;
  showHumanReadable?: boolean;
  imageUrl?: string;
  imageStoragePath?: string;
  imageFit?: "contain" | "cover";
  keepAspectRatio?: boolean;
  imageAspectRatio?: number;
  opacity?: number;
  locked?: boolean;
};

type LegacyPrintField = {
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
  backgroundColor?: string;
  showBorder?: boolean;
  borderWidth?: number;
  elements?: LabelElement[];
  fields?: LegacyPrintField[];
};

type PrintSettings = {
  dpi?: number;
  offsetXmm?: number;
  offsetYmm?: number;
  copies?: number;
};

type PrintJob = {
  title?: string;
  data?: Record<string, string>;
  renderedImages?: Record<string, string>;
};

type RequestBody = {
  printerName?: string;
  template?: PrintTemplate;
  printSettings?: PrintSettings;
  jobs?: PrintJob[];
};

function normalizeTemplate(template: PrintTemplate): PrintTemplate {
  if (Array.isArray(template.elements) && template.elements.length > 0) return template;
  const legacy = Array.isArray(template.fields) ? template.fields : [];
  return {
    ...template,
    backgroundColor: template.backgroundColor || "#ffffff",
    showBorder: template.showBorder !== false,
    borderWidth: Number(template.borderWidth) || 0.7,
    elements: legacy.map((field, index) => ({
      id: `legacy-${field.key || index}`,
      type: "field" as const,
      key: field.key,
      label: field.label,
      visible: field.visible !== false,
      x: Number(field.x) || 4,
      y: Number(field.y) || 4,
      width: Number(field.width) || 92,
      height: 10,
      zIndex: 10 + index,
      fontFamily: "Arial",
      labelFontSize: Math.max(4, (Number(field.fontSize) || 7) * 0.7),
      valueFontSize: Number(field.fontSize) || 7,
      labelBold: true,
      bold: Boolean(field.bold),
      italic: false,
      underline: false,
      align: field.align || "left",
      verticalAlign: "top" as const,
      stackedLabel: false,
      wrap: false,
      maxLines: 1,
      prefix: "",
      suffix: "",
      charSpacing: 0,
      rotation: 0 as const,
      textColor: "#000000",
      fillColor: "#ffffff",
      borderColor: "#000000",
      borderWidth: 0,
      borderRadius: 0,
      lineWidth: 0.8,
      hideWhenEmpty: false,
      showHumanReadable: false,
      imageUrl: "",
      imageStoragePath: "",
      imageFit: "contain" as const,
      keepAspectRatio: true,
      imageAspectRatio: 1,
      opacity: 1,
      locked: false,
    })),
  };
}

async function prepareQrImages(template: PrintTemplate, jobs: PrintJob[]): Promise<PrintJob[]> {
  const qrElements = (template.elements || []).filter((element) => element.visible !== false && element.type === "qrcode");
  if (qrElements.length === 0) return jobs;

  let qrModule: any;
  try {
    // Runtime import: így a route TypeScript-fordítása nem függ közvetlen típustól.
    qrModule = await (new Function("moduleName", "return import(moduleName)") as (name: string) => Promise<any>)("qrcode");
  } catch {
    throw new Error("A QR-kód nyomtatásához telepítsd a qrcode csomagot a Next.js projektben: npm install qrcode");
  }
  const qr = qrModule?.default || qrModule;
  if (!qr?.toDataURL) throw new Error("A qrcode csomag nem tölthető be megfelelően.");

  const output: PrintJob[] = [];
  for (const job of jobs) {
    const renderedImages: Record<string, string> = { ...(job.renderedImages || {}) };
    for (const element of qrElements) {
      const key = String(element.key || "");
      const value = key ? String(job.data?.[key] || "").trim() : "";
      if (!value) continue;
      renderedImages[element.id] = await qr.toDataURL(value, {
        margin: 0,
        errorCorrectionLevel: "M",
        width: 640,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
    output.push({ ...job, renderedImages });
  }
  return output;
}

async function prepareTemplateAssetImages(template: PrintTemplate, jobs: PrintJob[]): Promise<PrintJob[]> {
  const imageElements = (template.elements || []).filter((element) => element.visible !== false && element.type === "image" && String(element.imageUrl || "").trim());
  if (imageElements.length === 0) return jobs;

  const cached = new Map<string, string>();
  for (const element of imageElements) {
    const url = String(element.imageUrl || "").trim();
    if (!url || cached.has(url)) continue;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`A címkéhez tartozó kép nem tölthető le (${response.status}).`);
    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    cached.set(url, `data:${contentType};base64,${buffer.toString("base64")}`);
  }

  return jobs.map((job) => {
    const renderedImages: Record<string, string> = { ...(job.renderedImages || {}) };
    imageElements.forEach((element) => {
      const url = String(element.imageUrl || "").trim();
      const dataUrl = cached.get(url);
      if (dataUrl) renderedImages[element.id] = dataUrl;
    });
    return { ...job, renderedImages };
  });
}

const POWERSHELL_PRINT_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$printerName = [string]$config.printerName
$template = $config.template
$printSettings = $config.printSettings
$jobs = @($config.jobs)

if ([string]::IsNullOrWhiteSpace($printerName)) { throw 'Nincs megadva nyomtató.' }
if ($jobs.Count -eq 0) { throw 'Nincs nyomtatási feladat.' }

$widthMm = [double]$template.widthMm
$heightMm = [double]$template.heightMm
if ($widthMm -le 0 -or $heightMm -le 0) { throw 'Érvénytelen címkeméret.' }

$dpi = if ($null -ne $printSettings -and [double]$printSettings.dpi -gt 0) { [int]$printSettings.dpi } else { 203 }
$offsetXmm = if ($null -ne $printSettings) { [double]$printSettings.offsetXmm } else { 0.0 }
$offsetYmm = if ($null -ne $printSettings) { [double]$printSettings.offsetYmm } else { 0.0 }
$copies = if ($null -ne $printSettings -and [int]$printSettings.copies -gt 0) { [Math]::Min(20, [int]$printSettings.copies) } else { 1 }
$offsetXHi = [single](($offsetXmm / 25.4) * 100.0)
$offsetYHi = [single](($offsetYmm / 25.4) * 100.0)

$widthHi = [Math]::Max(1, [int][Math]::Round(($widthMm / 25.4) * 100.0))
$heightHi = [Math]::Max(1, [int][Math]::Round(($heightMm / 25.4) * 100.0))

function Get-HexColor([string]$hex, [System.Drawing.Color]$fallback) {
  try {
    if ([string]::IsNullOrWhiteSpace($hex)) { return $fallback }
    $clean = $hex.Trim().TrimStart('#')
    if ($clean.Length -eq 6) {
      return [System.Drawing.Color]::FromArgb(
        [Convert]::ToInt32($clean.Substring(0,2),16),
        [Convert]::ToInt32($clean.Substring(2,2),16),
        [Convert]::ToInt32($clean.Substring(4,2),16)
      )
    }
  } catch {}
  return $fallback
}

function Get-Pct([single]$page, $value, [single]$offset = 0) {
  $v = [double]$value
  return [single](($page * ([Math]::Max(-100.0, [Math]::Min(200.0, $v)) / 100.0)) + $offset)
}

function Get-FontStyle($bold, $italic, $underline) {
  $style = [System.Drawing.FontStyle]::Regular
  if ($bold -eq $true) { $style = $style -bor [System.Drawing.FontStyle]::Bold }
  if ($italic -eq $true) { $style = $style -bor [System.Drawing.FontStyle]::Italic }
  if ($underline -eq $true) { $style = $style -bor [System.Drawing.FontStyle]::Underline }
  return $style
}

function Get-StringAlignment([string]$align) {
  switch ($align) {
    'center' { return [System.Drawing.StringAlignment]::Center }
    'right' { return [System.Drawing.StringAlignment]::Far }
    default { return [System.Drawing.StringAlignment]::Near }
  }
}

function Get-VerticalAlignment([string]$align) {
  switch ($align) {
    'middle' { return [System.Drawing.StringAlignment]::Center }
    'bottom' { return [System.Drawing.StringAlignment]::Far }
    default { return [System.Drawing.StringAlignment]::Near }
  }
}

function New-RoundedPath([System.Drawing.RectangleF]$rect, [single]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($radius -le 0.1) { $path.AddRectangle($rect); return $path }
  $d = [Math]::Min([Math]::Min($rect.Width, $rect.Height), $radius * 2.0)
  $arc = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $d, $d)
  $path.AddArc($arc, 180, 90)
  $arc.X = $rect.Right - $d; $path.AddArc($arc, 270, 90)
  $arc.Y = $rect.Bottom - $d; $path.AddArc($arc, 0, 90)
  $arc.X = $rect.Left; $path.AddArc($arc, 90, 90)
  $path.CloseFigure()
  return $path
}

function Load-DataUrlImage([string]$dataUrl) {
  if ([string]::IsNullOrWhiteSpace($dataUrl)) { return $null }
  $comma = $dataUrl.IndexOf(',')
  if ($comma -lt 0) { return $null }
  $raw = $dataUrl.Substring($comma + 1)
  $bytes = [Convert]::FromBase64String($raw)
  $stream = New-Object System.IO.MemoryStream(,$bytes)
  try {
    $image = [System.Drawing.Image]::FromStream($stream)
    return @{ Image = $image; Stream = $stream }
  } catch {
    $stream.Dispose()
    return $null
  }
}

foreach ($job in $jobs) {
  for ($copyIndex = 0; $copyIndex -lt $copies; $copyIndex++) {
    $doc = New-Object System.Drawing.Printing.PrintDocument
    try {
      $doc.PrinterSettings.PrinterName = $printerName
      if (-not $doc.PrinterSettings.IsValid) { throw "A megadott nyomtató nem érhető el: $printerName" }

      try {
        $resolution = New-Object System.Drawing.Printing.PrinterResolution
        $resolution.Kind = [System.Drawing.Printing.PrinterResolutionKind]::Custom
        $resolution.X = $dpi
        $resolution.Y = $dpi
        $doc.DefaultPageSettings.PrinterResolution = $resolution
      } catch {}

      $paper = New-Object System.Drawing.Printing.PaperSize('NIVO_CUSTOM', $widthHi, $heightHi)
      $doc.DefaultPageSettings.PaperSize = $paper
      $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
      $doc.OriginAtMargins = $false
      $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
      $doc.DocumentName = if ([string]::IsNullOrWhiteSpace([string]$job.title)) { 'NIVO címke' } else { [string]$job.title }

      $handler = [System.Drawing.Printing.PrintPageEventHandler]{
        param($sender, $e)
        $graphics = $e.Graphics
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $pageWidth = [single]$e.PageBounds.Width
        $pageHeight = [single]$e.PageBounds.Height
        $background = Get-HexColor ([string]$template.backgroundColor) ([System.Drawing.Color]::White)
        $graphics.Clear($background)

        if ($template.showBorder -ne $false) {
          $borderWidth = [single][Math]::Max(0.2, [double]$template.borderWidth)
          $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, $borderWidth)
          try { $graphics.DrawRectangle($borderPen, 1, 1, [Math]::Max(1, $pageWidth - 2), [Math]::Max(1, $pageHeight - 2)) } finally { $borderPen.Dispose() }
        }

        $elements = @($template.elements | Sort-Object { [int]$_.zIndex })
        foreach ($element in $elements) {
          if ($element.visible -eq $false) { continue }

          $x = Get-Pct $pageWidth $element.x $offsetXHi
          $y = Get-Pct $pageHeight $element.y $offsetYHi
          $w = [single][Math]::Max(0.5, (Get-Pct $pageWidth $element.width 0))
          $h = [single][Math]::Max(0.5, (Get-Pct $pageHeight $element.height 0))
          $w = [Math]::Min($w, [Math]::Max(0.5, $pageWidth - $x))
          $h = [Math]::Min($h, [Math]::Max(0.5, $pageHeight - $y))
          $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
          $etype = [string]$element.type

          if ($etype -eq 'line') {
            $color = Get-HexColor ([string]$element.borderColor) ([System.Drawing.Color]::Black)
            $pen = New-Object System.Drawing.Pen($color, [single][Math]::Max(0.2, [double]$element.lineWidth))
            try {
              $x2 = $x + $w
              $y2 = if ([double]$element.height -eq 0) { $y } else { $y + $h }
              $graphics.DrawLine($pen, $x, $y, $x2, $y2)
            } finally { $pen.Dispose() }
            continue
          }

          if ($etype -eq 'box' -or $etype -eq 'filledBox') {
            $borderColor = Get-HexColor ([string]$element.borderColor) ([System.Drawing.Color]::Black)
            $fillColor = Get-HexColor ([string]$element.fillColor) ([System.Drawing.Color]::White)
            $pen = New-Object System.Drawing.Pen($borderColor, [single][Math]::Max(0.2, [double]$element.borderWidth))
            $brush = New-Object System.Drawing.SolidBrush($fillColor)
            $path = New-RoundedPath $rect ([single][Math]::Max(0, [double]$element.borderRadius))
            try {
              if ($etype -eq 'filledBox') { $graphics.FillPath($brush, $path) }
              $graphics.DrawPath($pen, $path)
            } finally { $path.Dispose(); $brush.Dispose(); $pen.Dispose() }
            continue
          }

          if ($etype -eq 'barcode' -or $etype -eq 'qrcode' -or $etype -eq 'image') {
            $imageData = $null
            if ($null -ne $job.renderedImages -and $job.renderedImages.PSObject.Properties.Name -contains [string]$element.id) {
              $imageData = [string]$job.renderedImages.PSObject.Properties[[string]$element.id].Value
            }
            $loaded = Load-DataUrlImage $imageData
            if ($null -ne $loaded) {
              try {
                if ($etype -eq 'image') {
                  $state = $graphics.Save()
                  $attrs = New-Object System.Drawing.Imaging.ImageAttributes
                  try {
                    $rotation = [int]$element.rotation
                    if ($rotation -ne 0) {
                      $cx = $rect.X + ($rect.Width / 2.0); $cy = $rect.Y + ($rect.Height / 2.0)
                      $graphics.TranslateTransform($cx, $cy); $graphics.RotateTransform($rotation); $graphics.TranslateTransform(-$cx, -$cy)
                    }
                    $opacity = [single]1.0
                    if ($null -ne $element.opacity) { $opacity = [single][Math]::Max(0.0, [Math]::Min(1.0, [double]$element.opacity)) }
                    $matrix = New-Object System.Drawing.Imaging.ColorMatrix
                    $matrix.Matrix33 = $opacity
                    $attrs.SetColorMatrix($matrix, [System.Drawing.Imaging.ColorMatrixFlag]::Default, [System.Drawing.Imaging.ColorAdjustType]::Bitmap)
                    $srcW = [single]$loaded.Image.Width; $srcH = [single]$loaded.Image.Height
                    $fit = [string]$element.imageFit
                    if ($fit -eq 'cover' -and $srcW -gt 0 -and $srcH -gt 0 -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
                      $srcRatio = $srcW / $srcH; $dstRatio = $rect.Width / $rect.Height
                      $sx = [single]0; $sy = [single]0; $sw = $srcW; $sh = $srcH
                      if ($srcRatio -gt $dstRatio) { $sw = $srcH * $dstRatio; $sx = ($srcW - $sw) / 2.0 } else { $sh = $srcW / $dstRatio; $sy = ($srcH - $sh) / 2.0 }
                      $graphics.DrawImage($loaded.Image, $rect, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
                    } else {
                      $target = $rect
                      if ($srcW -gt 0 -and $srcH -gt 0 -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
                        $scale = [Math]::Min($rect.Width / $srcW, $rect.Height / $srcH)
                        $tw = [single]($srcW * $scale); $th = [single]($srcH * $scale)
                        $target = New-Object System.Drawing.RectangleF(($rect.X + ($rect.Width - $tw) / 2.0), ($rect.Y + ($rect.Height - $th) / 2.0), $tw, $th)
                      }
                      $graphics.DrawImage($loaded.Image, $target, 0, 0, $srcW, $srcH, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
                    }
                  } finally { $attrs.Dispose(); $graphics.Restore($state) }
                } else {
                  $graphics.DrawImage($loaded.Image, $rect)
                }
              } finally { $loaded.Image.Dispose(); $loaded.Stream.Dispose() }
            }
            continue
          }

          $rawValue = ''
          if ($etype -eq 'staticText') {
            $rawValue = [string]$element.text
          } else {
            $key = [string]$element.key
            if ($null -ne $job.data -and $job.data.PSObject.Properties.Name -contains $key) {
              $rawValue = [string]$job.data.PSObject.Properties[$key].Value
            }
            if ($element.hideWhenEmpty -eq $true -and [string]::IsNullOrWhiteSpace($rawValue)) { continue }
            $rawValue = ([string]$element.prefix) + $rawValue + ([string]$element.suffix)
          }
          if ([string]::IsNullOrWhiteSpace($rawValue) -and $etype -ne 'staticText') { $rawValue = '-' }

          $fontFamily = if ([string]::IsNullOrWhiteSpace([string]$element.fontFamily)) { 'Arial' } else { [string]$element.fontFamily }
          $valueStyle = Get-FontStyle ($element.bold -eq $true) ($element.italic -eq $true) ($element.underline -eq $true)
          $labelStyle = Get-FontStyle ($element.labelBold -eq $true) $false $false
          $valueFont = New-Object System.Drawing.Font($fontFamily, [single][Math]::Max(3.0, [double]$element.valueFontSize), $valueStyle)
          $labelFont = New-Object System.Drawing.Font($fontFamily, [single][Math]::Max(3.0, [double]$element.labelFontSize), $labelStyle)
          $brush = New-Object System.Drawing.SolidBrush((Get-HexColor ([string]$element.textColor) ([System.Drawing.Color]::Black)))
          $format = New-Object System.Drawing.StringFormat
          try {
            $format.Alignment = Get-StringAlignment ([string]$element.align)
            $format.LineAlignment = Get-VerticalAlignment ([string]$element.verticalAlign)
            $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
            if ($element.wrap -ne $true) { $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap }

            $spacing = [double]$element.charSpacing
            $valueText = $rawValue
            if ($spacing -ge 1.0) {
              $sp = ' ' * [Math]::Min(5, [int][Math]::Round($spacing))
              $valueText = (($rawValue.ToCharArray() | ForEach-Object { [string]$_ }) -join $sp)
            }

            $state = $graphics.Save()
            try {
              $rotation = [int]$element.rotation
              if ($rotation -ne 0) {
                $cx = $rect.X + ($rect.Width / 2.0); $cy = $rect.Y + ($rect.Height / 2.0)
                $graphics.TranslateTransform($cx, $cy)
                $graphics.RotateTransform($rotation)
                $graphics.TranslateTransform(-$cx, -$cy)
              }

              $label = [string]$element.label
              if ($etype -eq 'field' -and -not [string]::IsNullOrWhiteSpace($label)) {
                if ($element.stackedLabel -eq $true) {
                  $labelH = [single][Math]::Max(5, $rect.Height * 0.34)
                  $labelRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $rect.Width, $labelH)
                  $valueRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y + $labelH, $rect.Width, [Math]::Max(1, $rect.Height - $labelH))
                  $labelFormat = New-Object System.Drawing.StringFormat
                  try {
                    $labelFormat.Alignment = $format.Alignment
                    $labelFormat.LineAlignment = [System.Drawing.StringAlignment]::Near
                    $graphics.DrawString($label, $labelFont, $brush, $labelRect, $labelFormat)
                    $graphics.DrawString($valueText, $valueFont, $brush, $valueRect, $format)
                  } finally { $labelFormat.Dispose() }
                } else {
                  $labelText = ([string]$label) + ':'
                  $labelSize = $graphics.MeasureString($labelText, $labelFont)
                  $labelRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, [Math]::Min($rect.Width, $labelSize.Width + 2), $rect.Height)
                  $graphics.DrawString($labelText, $labelFont, $brush, $labelRect)
                  $valueX = $rect.X + [Math]::Min($rect.Width, $labelSize.Width + 2)
                  $valueRect = New-Object System.Drawing.RectangleF($valueX, $rect.Y, [Math]::Max(1, $rect.Right - $valueX), $rect.Height)
                  $graphics.DrawString($valueText, $valueFont, $brush, $valueRect, $format)
                }
              } else {
                $graphics.DrawString($valueText, $valueFont, $brush, $rect, $format)
              }
            } finally { $graphics.Restore($state) }
          } finally {
            $format.Dispose(); $brush.Dispose(); $labelFont.Dispose(); $valueFont.Dispose()
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
    const originalJobs = Array.isArray(body?.jobs) ? body.jobs : [];
    const template = body?.template ? normalizeTemplate(body.template) : null;
    const printSettings: PrintSettings = {
      dpi: Math.max(100, Math.round(Number(body?.printSettings?.dpi) || 203)),
      offsetXmm: Number(body?.printSettings?.offsetXmm) || 0,
      offsetYmm: Number(body?.printSettings?.offsetYmm) || 0,
      copies: Math.max(1, Math.min(20, Math.round(Number(body?.printSettings?.copies) || 1))),
    };

    if (!printerName) return NextResponse.json({ error: "Nincs kiválasztott nyomtató." }, { status: 400 });
    if (!template || !Number(template.widthMm) || !Number(template.heightMm) || !Array.isArray(template.elements)) {
      return NextResponse.json({ error: "Érvénytelen címkesablon." }, { status: 400 });
    }
    if (originalJobs.length === 0) return NextResponse.json({ error: "Nincs nyomtatandó címke." }, { status: 400 });

    const qrJobs = await prepareQrImages(template, originalJobs);
    const jobs = await prepareTemplateAssetImages(template, qrJobs);
    const token = crypto.randomBytes(8).toString("hex");
    configPath = path.join(os.tmpdir(), `nivo-label-${token}.json`);
    scriptPath = path.join(os.tmpdir(), `nivo-label-${token}.ps1`);

    await fs.writeFile(configPath, JSON.stringify({ printerName, template, printSettings, jobs }), "utf8");
    await fs.writeFile(scriptPath, POWERSHELL_PRINT_SCRIPT, "utf8");

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ConfigPath", configPath],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 180000 }
    );

    return NextResponse.json({ ok: true, printerName, printedCount: jobs.length * (printSettings.copies || 1) });
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
