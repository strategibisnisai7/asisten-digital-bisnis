export class GoogleSheetsError extends Error {
  constructor(
    public readonly code: "CONFIG" | "SCHEMA" | "AUTH" | "ACCESS" | "NOT_FOUND" | "API",
    message: string,
  ) {
    super(message);
    this.name = "GoogleSheetsError";
  }
}

// Never retain/log the original Google error: it may contain request credentials.
export function sanitizeGoogleSheetsError(error: unknown): GoogleSheetsError {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 401) {
    return new GoogleSheetsError("AUTH", "Autentikasi Google gagal. Periksa credentials service account.");
  }
  if (status === 403) {
    return new GoogleSheetsError("ACCESS", "Akses ditolak. Aktifkan Google Sheets API dan bagikan spreadsheet ke service account sebagai Viewer.");
  }
  if (status === 404) {
    return new GoogleSheetsError("NOT_FOUND", "Spreadsheet tidak ditemukan atau belum dibagikan ke service account. Periksa ID dan akses.");
  }
  return new GoogleSheetsError("API", "Gagal membaca Google Sheets. Periksa jaringan, credentials, kuota API, dan keberadaan sheet Stok.");
}
