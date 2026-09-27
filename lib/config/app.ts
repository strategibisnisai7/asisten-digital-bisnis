/**
 * Per-client identity. Defaults serve the current client; another deployment can set
 * COMPANY_NAME and ASSISTANT_NAME without code changes. The spreadsheet itself comes
 * from GOOGLE_SHEETS_SPREADSHEET_ID (see lib/google-sheets/config.ts).
 */
export interface AppConfig { companyName: string; assistantName: string; timeZone: string }

export const TIME_ZONE = "Asia/Jakarta";

export function getAppConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  return {
    companyName: env.COMPANY_NAME?.trim() || "PT Indah Merta Anugerah",
    assistantName: env.ASSISTANT_NAME?.trim() || "Asisten Digital",
    timeZone: TIME_ZONE,
  };
}
