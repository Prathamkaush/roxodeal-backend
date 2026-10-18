import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createTransport } from "nodemailer";
@Injectable()
export class Delivery {
  ensureSms() {
    if (!process.env.SMS_PROVIDER_URL || !process.env.SMS_PROVIDER_TOKEN)
      throw new ServiceUnavailableException(
        "SMS delivery is not configured. Contact support.",
      );
  }
  async sms(phone: string, message: string) {
    this.ensureSms();
    const r = await fetch(process.env.SMS_PROVIDER_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SMS_PROVIDER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: phone, message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw new ServiceUnavailableException(
        "SMS delivery failed. Please try again later.",
      );
  }
  async email(to: string, subject: string, text: string) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
      throw new ServiceUnavailableException(
        "Email delivery is not configured. Contact support.",
      );
    try {
      await createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_PORT === "465",
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
          : undefined,
      }).sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    } catch {
      throw new ServiceUnavailableException(
        "Email delivery failed. Please try again later.",
      );
    }
  }
}
