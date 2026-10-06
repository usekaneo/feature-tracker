import nodemailer from "nodemailer";
import type { MailConfig } from "../config";
import type { Logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface SentMail extends MailMessage {
  id: number;
  sentAt: Date;
}

export interface Mailer {
  readonly transport: MailConfig["transport"];
  send(message: MailMessage): Promise<void>;
  /** Checks SMTP connectivity and authentication before serving production traffic. */
  verify?(): Promise<void>;
  /** Messages captured by the dev transport. Empty for other transports. */
  outbox(): SentMail[];
}

export function createMailer(config: MailConfig, logger: Logger): Mailer {
  if (config.transport === "smtp") {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return {
      transport: "smtp",
      async verify() {
        await transporter.verify();
      },
      async send(message) {
        await transporter.sendMail({ from: config.from, ...message });
      },
      outbox: () => [],
    };
  }

  if (config.transport === "dev") {
    const sent: SentMail[] = [];
    let nextId = 1;
    return {
      transport: "dev",
      async send(message) {
        sent.unshift({ ...message, id: nextId++, sentAt: new Date() });
        sent.length = Math.min(sent.length, 50);
        // Development only: links are printed so flows can be completed without SMTP.
        logger.info(`[dev mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
      },
      outbox: () => sent,
    };
  }

  return {
    transport: "disabled",
    async send(message) {
      logger.error(`Email not sent (SMTP not configured): subject="${message.subject}"`);
    },
    outbox: () => [],
  };
}
