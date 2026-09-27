import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { getGoogleSheetsConfig } from "../google-sheets/config";
import { GoogleSheetsError, sanitizeGoogleSheetsError } from "../google-sheets/errors";

export interface SheetValues {
  range: string;
  majorDimension: string;
  values: unknown[][];
}


const READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
// Write access is requested only by the functions below; reads stay read-only.
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const REQUEST_OPTIONS = { timeout: 15_000, retry: false } as const;

function client(scope: string): { sheets: sheets_v4.Sheets; spreadsheetId: string } {
  const { spreadsheetId, clientEmail, privateKey } = getGoogleSheetsConfig();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: [scope],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

/** Read current values from Sheets using server-side environment credentials. */
export async function readSheetRange(range: string): Promise<SheetValues> {
  const { sheets, spreadsheetId } = client(READ_SCOPE);
  try {
    const { data } = await sheets.spreadsheets.values.get(
      { spreadsheetId, range, majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" },
      REQUEST_OPTIONS,
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

export interface GridCellUpdate { sheetTitle: string; rowNumber: number; columnIndex: number; value: number }
export interface GridAppend { sheetTitle: string; rows: readonly (readonly (string | number)[])[] }

const cellValue = (value: string | number): sheets_v4.Schema$CellData =>
  ({ userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value } });

/**
 * Applies cell updates and an append in ONE spreadsheets.batchUpdate request, which
 * Google applies atomically: either every change lands or none does. Values are
 * stored as plain numbers/strings, never as formulas.
 */
export async function applyAtomicChanges(updates: readonly GridCellUpdate[], append?: GridAppend): Promise<void> {
  if (!updates.length && !append?.rows.length) return;
  const { sheets, spreadsheetId } = client(WRITE_SCOPE);
  try {
    const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(title,sheetId)" }, REQUEST_OPTIONS);
    const ids = new Map((data.sheets ?? []).map((sheet) => [sheet.properties?.title, sheet.properties?.sheetId]));
    const sheetId = (title: string) => {
      const id = ids.get(title);
      if (typeof id !== "number") throw new GoogleSheetsError("SCHEMA", `Tab '${title}' tidak ditemukan di spreadsheet.`);
      return id;
    };
    const requests: sheets_v4.Schema$Request[] = updates.map((update) => ({
      updateCells: {
        range: {
          sheetId: sheetId(update.sheetTitle),
          startRowIndex: update.rowNumber - 1, endRowIndex: update.rowNumber,
          startColumnIndex: update.columnIndex, endColumnIndex: update.columnIndex + 1,
        },
        rows: [{ values: [cellValue(update.value)] }],
        fields: "userEnteredValue",
      },
    }));
    if (append?.rows.length) {
      requests.push({
        appendCells: {
          sheetId: sheetId(append.sheetTitle),
          rows: append.rows.map((row) => ({ values: row.map(cellValue) })),
          fields: "userEnteredValue",
        },
      });
    }
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, REQUEST_OPTIONS);
  } catch (error) {
    if (error instanceof GoogleSheetsError) throw error;
    throw sanitizeGoogleSheetsError(error);
  }
}

export type EnsureSheetResult = { sheetCreated: boolean; headerWritten: boolean };

/**
 * Creates the tab when it is missing and writes the header only into an empty first
 * row. Existing tabs and existing data are never cleared or overwritten.
 */
export async function ensureSheetWithHeader(title: string, header: readonly string[]): Promise<EnsureSheetResult> {
  const { sheets, spreadsheetId } = client(WRITE_SCOPE);
  const quoted = `'${title.replace(/'/g, "''")}'`;
  const lastColumn = String.fromCharCode(64 + header.length);
  try {
    const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" }, REQUEST_OPTIONS);
    const exists = (data.sheets ?? []).some((sheet) => sheet.properties?.title === title);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
      }, REQUEST_OPTIONS);
    }
    const { data: firstRow } = await sheets.spreadsheets.values.get(
      { spreadsheetId, range: `${quoted}!A1:${lastColumn}1` },
      REQUEST_OPTIONS,
    );
    const filled = (firstRow.values?.[0] ?? []).some((cell) => String(cell ?? "").trim() !== "");
    if (!filled) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoted}!A1:${lastColumn}1`,
        valueInputOption: "RAW",
        requestBody: { values: [[...header]] },
      }, REQUEST_OPTIONS);
    }
    return { sheetCreated: !exists, headerWritten: !filled };
  } catch (error) {
    throw sanitizeGoogleSheetsError(error);
  }
}
