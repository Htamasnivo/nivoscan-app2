import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const maxDuration = 60;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

function cleanText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecipients(value: string): string[] {
  return value.split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean);
}

async function fileToAttachment(entry: FormDataEntryValue | null, fallbackName: string, fallbackContentType: string) {
  if (!(entry instanceof File) || entry.size === 0) return null;
  const arrayBuffer = await entry.arrayBuffer();
  return {
    filename: entry.name || fallbackName,
    content: Buffer.from(arrayBuffer),
    contentType: entry.type || fallbackContentType,
  };
}

export async function POST(request: NextRequest) {
  try {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return NextResponse.json({ ok: false, error: "Hiányzik a GMAIL_USER vagy GMAIL_APP_PASSWORD Vercel környezeti változó." }, { status: 500 });
    }

    const formData = await request.formData();
    const toRaw = cleanText(formData.get("to"));
    const subject = cleanText(formData.get("subject")) || "NÍVÓ automatikus riport";
    const html = cleanText(formData.get("html"));
    const text = cleanText(formData.get("text"));
    const requestedFormat = cleanText(formData.get("requestedFormat")).toLowerCase();
    const recipients = normalizeRecipients(toRaw);

    if (recipients.length === 0) {
      return NextResponse.json({ ok: false, error: "Nincs megadva címzett email-cím." }, { status: 400 });
    }

    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

    if (requestedFormat === "pdf" || requestedFormat === "both") {
      const pdfAttachment = await fileToAttachment(formData.get("pdf"), "nivo_riport.pdf", "application/pdf");
      if (!pdfAttachment) {
        return NextResponse.json({ ok: false, error: "PDF küldés lett kérve, de a PDF melléklet hiányzik." }, { status: 400 });
      }
      attachments.push(pdfAttachment);
    }

    if (requestedFormat === "excel" || requestedFormat === "both") {
      const excelAttachment = await fileToAttachment(
        formData.get("excel"),
        "nivo_riport.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      if (!excelAttachment) {
        return NextResponse.json({ ok: false, error: "Excel küldés lett kérve, de az Excel melléklet hiányzik." }, { status: 400 });
      }
      attachments.push(excelAttachment);
    }

    const totalAttachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.content.length, 0);
    if (totalAttachmentBytes > 18 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "A mellékletek összmérete túl nagy az emailes küldéshez." }, { status: 413 });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ""),
      },
    });

    await transporter.verify();

    const info = await transporter.sendMail({
      from: `"NÍVÓ Automatikus Riport" <${GMAIL_USER}>`,
      to: recipients.join(", "),
      subject,
      text: text || "A csatolt fájl automatikusan generált NÍVÓ riport.",
      html: html || "<p>A csatolt fájl automatikusan generált <strong>NÍVÓ riport</strong>.</p>",
      attachments,
    });

    return NextResponse.json({
      ok: true,
      message: "Email sikeresen elküldve.",
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      recipients,
    });
  } catch (error: any) {
    console.error("/api/send-report Gmail hiba:", error);
    const errorMessage = error?.response || error?.message || "Ismeretlen hiba történt az email küldése közben.";
    return NextResponse.json({ ok: false, error: String(errorMessage) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "NÍVÓ Gmail report sender",
    gmailConfigured: Boolean(GMAIL_USER && GMAIL_APP_PASSWORD),
  });
}
