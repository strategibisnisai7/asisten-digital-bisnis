import "server-only";
import { google } from "googleapis";
import { getGoogleSheetsConfig } from "../google-sheets/config";
import { sanitizeGoogleSheetsError } from "../google-sheets/errors";

export interface SheetValues {
  range: string;
  majorDimension: string;
  values: unknown[][];
}

/** Read current values from Sheets using server-side environment credentials. */
export async function readSheetRange(range: string): Promise<SheetValues> {
  const { spreadsheetId, clientEmail, privateKey } = getGoogleSheetsConfig();

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const { data } = await sheets.spreadsheets.values.get(
      {
        spreadsheetId,
        range,
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      },
      { timeout: 15_000, retry: false },
    );

    // Return only sheet values, never the HTTP response or auth configuration.
    return {
      range: data.range ?? range,
      majorDimension: data.majorDimension ?? "ROWS",
      values: data.values ?? [],
    };
  } catch (error) {
    throw sanitizeGoogleSheetsError(error);
  }
}
