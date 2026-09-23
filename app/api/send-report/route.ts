import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A Gmail legfeljebb kb. 25 MB méretű teljes e-mailt enged.
// A mellékletek MIME/base64 kódolással kb. 37%-kal nagyobbak lesznek.
const MAX_RAW_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const MAX_INLINE_LOGO_BYTES = 5 * 1024 * 1024;

function splitRecipients(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[;,\n]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeFileName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
  return cleaned || fallback;
}

async function fileToAttachment(value: FormDataEntryValue | null, fallbackName: string) {
  if (!(value instanceof File) || value.size <= 0) return null;
  return {
    filename: safeFileName(value.name || fallbackName, fallbackName),
    content: Buffer.from(await value.arrayBuffer()),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Ugyanazok a Vercel környezeti változók, mint a korábbi Gmail-küldésnél.
    // A Google alkalmazásjelszavában a másoláskor bekerült szóközöket eltávolítjuk.
    const gmailUser = String(process.env.GMAIL_USER || "").trim();
    const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, "");

    if (!gmailUser || !gmailAppPassword) {
      return NextResponse.json(
        { error: "A Gmail-küldéshez a GMAIL_USER és GMAIL_APP_PASSWORD Vercel környezeti változó szükséges." },
        { status: 500 }
      );
    }
    if (!isEmail(gmailUser)) {
      return NextResponse.json(
        { error: "A GMAIL_USER környezeti változó nem érvényes e-mail-cím." },
        { status: 500 }
      );
    }

    const formData = await request.formData();
    const recipients = splitRecipients(String(formData.get("to") || "").trim());
    if (!recipients.length) {
      return NextResponse.json({ error: "Nincs megadva e-mail-címzett." }, { status: 400 });
    }
    const invalidRecipients = recipients.filter((recipient) => !isEmail(recipient));
    if (invalidRecipients.length) {
      return NextResponse.json(
        { error: `Hibás e-mail-cím: ${invalidRecipients.join(", ")}` },
        { status: 400 }
      );
    }

    const subject = String(formData.get("subject") || "NÍVÓ termelési riport").trim() || "NÍVÓ termelési riport";
    const html = String(formData.get("html") || "").trim();
    const text = String(formData.get("text") || "").trim();
    const pdfEntry = formData.get("pdf");
    const excelEntry = formData.get("excel");
    const logoEntry = formData.get("logo");
    const rawBytes = [pdfEntry, excelEntry, logoEntry].reduce<number>(
      (sum, item) => sum + (item instanceof File ? item.size : 0),
      0
    );
    if (rawBytes > MAX_RAW_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: "A mellékletek túl nagyok a Gmail 25 MB-os üzenetméretéhez. Csökkentsd a PDF/Excel méretét." },
        { status: 413 }
      );
    }

    if (html.includes("cid:nivo-report-logo") && !(logoEntry instanceof File && logoEntry.size > 0)) {
      return NextResponse.json(
        { error: "A HTML-riporthoz szükséges NÍVÓ logó hiányzik." },
        { status: 400 }
      );
    }
    if (logoEntry instanceof File && logoEntry.size > 0) {
      if (!logoEntry.type.startsWith("image/") || logoEntry.size > MAX_INLINE_LOGO_BYTES) {
        return NextResponse.json(
          { error: "A NÍVÓ logó legfeljebb 5 MB-os képfájl lehet." },
          { status: 400 }
        );
      }
    }

    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
      cid?: string;
      contentDisposition?: "inline";
    }> = [];
    const pdf = await fileToAttachment(pdfEntry, "nivo_riport.pdf");
    const excel = await fileToAttachment(excelEntry, "nivo_riport.xlsx");
    if (pdf) attachments.push({ ...pdf, contentType: "application/pdf" });
    if (excel) attachments.push({
      ...excel,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    if (logoEntry instanceof File && logoEntry.size > 0) {
      const logo = await fileToAttachment(logoEntry, "nivo-logo.png");
      if (logo) attachments.push({
        ...logo,
        contentType: logoEntry.type,
        cid: "nivo-report-logo",
        contentDisposition: "inline",
      });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailAppPassword },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
    });

    // A Gmail a hitelesített GMAIL_USER címéről küld; nem szükséges Resend.
    const result = await transporter.sendMail({
      from: { name: "NÍVÓ Riport", address: gmailUser },
      to: recipients,
      subject,
      text: text || (html ? undefined : "Automatikusan generált NÍVÓ termelési riport."),
      ...(html ? { html } : {}),
      ...(attachments.length ? { attachments } : {}),
    });

    const accepted = (result.accepted || []).map(String);
    const rejected = (result.rejected || []).map(String);
    if (!accepted.length || rejected.length) {
      return NextResponse.json(
        {
          error: rejected.length
            ? `A Gmail nem fogadta el az összes címzettet: ${rejected.join(", ")}`
            : "A Gmail nem fogadta el a levelet.",
          provider: "gmail",
          accepted,
          rejected,
          id: result.messageId || null,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      provider: "gmail",
      id: result.messageId || null,
      recipients,
      attachmentCount: attachments.length,
    });
  } catch (error: unknown) {
    // A jelszó vagy más titok nem kerülhet a klienshez vagy a naplóba.
    const smtpError = error as { code?: string; responseCode?: number; message?: string };
    const code = String(smtpError?.code || "");
    console.error("/api/send-report Gmail-küldési hiba:", {
      code: code || undefined,
      responseCode: smtpError?.responseCode,
    });

    let message = "A Gmail e-mail küldése nem sikerült. Ellenőrizd a Vercel GMAIL_USER és GMAIL_APP_PASSWORD beállításokat.";
    if (smtpError?.responseCode === 535 || code === "EAUTH") {
      message = "Gmail-hitelesítési hiba. Ellenőrizd a GMAIL_USER címet és a Google alkalmazásjelszót (nem a szokásos fiókjelszót).";
    } else if (["ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(code)) {
      message = "Nem sikerült kapcsolatot létesíteni a Gmail SMTP-szerverével. Ellenőrizd a hálózati és SMTP-beállításokat.";
    }
    return NextResponse.json({ error: message, provider: "gmail" }, { status: 502 });
  }
}
