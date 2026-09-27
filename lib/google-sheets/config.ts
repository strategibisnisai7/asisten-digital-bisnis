import "server-only";
import { GoogleSheetsError } from "./errors";

export function getGoogleSheetsConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const required = [
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    "GOOGLE_SHEETS_CLIENT_EMAIL",
    "GOOGLE_SHEETS_PRIVATE_KEY",
  ] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new GoogleSheetsError("CONFIG", `Environment variable belum diisi: ${missing.join(", ")}. Isi .env secara lokal; jangan kirim private key melalui chat.`);
  }

  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID!.trim();
  const clientEmail = env.GOOGLE_SHEETS_CLIENT_EMAIL!.trim();
  const privateKey = env.GOOGLE_SHEETS_PRIVATE_KEY!.replace(/\\n/g, "\n").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
    throw new GoogleSheetsError("CONFIG", "GOOGLE_SHEETS_SPREADSHEET_ID harus berupa ID, bukan URL spreadsheet.");
  }
  if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(clientEmail)) {
    throw new GoogleSheetsError("CONFIG", "GOOGLE_SHEETS_CLIENT_EMAIL harus berupa email service account.");
  }
  if (!privateKey.startsWith("-----BEGIN PRIVATE KEY-----") || !privateKey.endsWith("-----END PRIVATE KEY-----")) {
    throw new GoogleSheetsError("CONFIG", "GOOGLE_SHEETS_PRIVATE_KEY harus berisi private_key PEM lengkap dari service account.");
  }
  return { spreadsheetId, clientEmail, privateKey };
}
