import { GoogleSheetsError } from "@/lib/google-sheets/errors";
import { readSheetRange } from "@/lib/sheets/google-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

// Temporary integration endpoint: the range is fixed and cannot be overridden.
export async function GET() {
  // This temporary diagnostic endpoint must never expose inventory in deployments.
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }
  try {
    const data = await readSheetRange("Stok!A1:L5");
    return Response.json(data, { headers });
  } catch (error) {
    // Known errors contain only controlled messages, never raw Google errors.
    if (error instanceof GoogleSheetsError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "CONFIG" ? 500 : 502, headers },
      );
    }
    return Response.json(
      { error: { code: "INTERNAL", message: "Gagal membaca Google Sheets." } },
      { status: 500, headers },
    );
  }
}
