import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RAW_ATTACHMENT_BYTES = 29 * 1024 * 1024;

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
  if (value.size > MAX_RAW_ATTACHMENT_BYTES) {
    throw new Error(`A(z) ${value.name || fallbackName} csatolmány túl nagy.`);
  }

  const bytes = Buffer.from(await value.arrayBuffer());
  return {
    filename: safeFileName(value.name || fallbackName, fallbackName),
    content: bytes.toString("base64"),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "Hiányzik a RESEND_API_KEY környezeti változó a Vercel projektből." },
        { status: 500 }
      );
    }

    const from = (
      process.env.REPORT_FROM_EMAIL ||
      process.env.RESEND_FROM_EMAIL ||
      process.env.EMAIL_FROM ||
      "NÍVÓ Riport <onboarding@resend.dev>"
    ).trim();

    const formData = await request.formData();
    const toRaw = String(formData.get("to") || "").trim();
    const recipients = splitRecipients(toRaw);
    const invalidRecipients = recipients.filter((item) => !isEmail(item));

    if (!recipients.length) {
      return NextResponse.json({ error: "Nincs megadva email címzett." }, { status: 400 });
    }
    if (invalidRecipients.length) {
      return NextResponse.json(
        { error: `Hibás email cím: ${invalidRecipients.join(", ")}` },
        { status: 400 }
      );
    }

    const subject = String(formData.get("subject") || "NÍVÓ termelési riport").trim() || "NÍVÓ termelési riport";
    const html = String(formData.get("html") || "").trim();
    const text = String(formData.get("text") || "").trim();

    const attachments = [] as Array<{ filename: string; content: string }>;
    const pdfAttachment = await fileToAttachment(formData.get("pdf"), "nivo_riport.pdf");
    const excelAttachment = await fileToAttachment(formData.get("excel"), "nivo_riport.xlsx");
    if (pdfAttachment) attachments.push(pdfAttachment);
    if (excelAttachment) attachments.push(excelAttachment);

    const rawBytes = [formData.get("pdf"), formData.get("excel")].reduce((sum, item) => {
      return sum + (item instanceof File ? item.size : 0);
    }, 0);
    if (rawBytes > MAX_RAW_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: "A csatolmányok összmérete túl nagy az email küldéshez." },
        { status: 413 }
      );
    }

    const payload: Record<string, unknown> = {
      from,
      to: recipients,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    if (!html && !text) {
      payload.text = "Automatikusan generált NÍVÓ termelési riport.";
    }

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const responseText = await resendResponse.text();
    let responseData: any = null;
    try {
      responseData = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseData = null;
    }

    if (!resendResponse.ok) {
      const resendMessage = String(
        responseData?.message || responseData?.error?.message || responseData?.error || responseText || "Resend küldési hiba"
      ).trim();
      return NextResponse.json(
        {
          error: resendMessage,
          provider: "resend",
          status: resendResponse.status,
        },
        { status: resendResponse.status >= 400 && resendResponse.status < 600 ? resendResponse.status : 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      id: responseData?.id || null,
      recipients,
      attachmentCount: attachments.length,
    });
  } catch (error: any) {
    console.error("/api/send-report hiba:", error);
    return NextResponse.json(
      { error: error?.message || "Ismeretlen szerveroldali email küldési hiba." },
      { status: 500 }
    );
  }
}
