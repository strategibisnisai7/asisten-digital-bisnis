import "server-only";
import { timingSafeEqual } from "node:crypto";

export class TelegramError extends Error {
  constructor(public readonly code: "CONFIG" | "API", message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

export function getTelegramToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new TelegramError("CONFIG", "TELEGRAM_BOT_TOKEN belum diisi.");
  return token;
}

export function getWebhookSecret(): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new TelegramError("CONFIG", "TELEGRAM_WEBHOOK_SECRET harus berisi 32–256 karakter huruf, angka, underscore, atau tanda hubung.");
  }
  return secret;
}

/**
 * Saving stock changes from Telegram stays off unless explicitly enabled. When off,
 * confirmations are validated but nothing is written to Google Sheets.
 */
export function isStockWriteEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.TELEGRAM_STOCK_WRITE_ENABLED?.trim().toLowerCase() === "true";
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
