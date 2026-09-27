/**
 * Every user-facing message ends with one small footer linking the stock file.
 * Messages are built as plain text; the transport escapes them for Telegram's HTML
 * mode and appends the footer, so sheet content can never inject markup.
 */
export const DEFAULT_STOCK_FILE_URL = "https://tinyurl.com/faststock";
/** The footer as Telegram returns it in message.text (tags removed). */
export const FOOTER_TEXT = "File stok XLS: Lihat File";

export function getStockFileUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = env.STOCK_FILE_URL?.trim();
  return url && /^https:\/\/\S+$/.test(url) ? url : DEFAULT_STOCK_FILE_URL;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function footerHtml(url = getStockFileUrl()): string {
  return `<i>File stok XLS: <a href="${escapeHtml(url)}">Lihat File</a></i>`;
}

/** Plain text → Telegram HTML with the footer added exactly once. */
export function withFooter(text: string, url = getStockFileUrl()): string {
  return `${escapeHtml(stripFooter(text))}\n\n${footerHtml(url)}`;
}

/** Removes the footer from text Telegram sends back (callbacks, replied-to messages). */
export function stripFooter(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(FOOTER_TEXT) ? trimmed.slice(0, -FOOTER_TEXT.length).trimEnd() : text;
}

/** Visible length after Telegram parses the HTML: the text plus the footer line. */
export function visibleLength(text: string): number {
  return stripFooter(text).length + 2 + FOOTER_TEXT.length;
}
