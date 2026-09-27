import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { reportFileName, type MonthlyReport } from "./report-service";

export interface GeneratedPdf { filename: string; bytes: Uint8Array; pageCount: number }

// A4 landscape leaves room for the 12-column transaction table.
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 36;
const FOOTER_HEIGHT = 26;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = MARGIN + FOOTER_HEIGHT;

const COLOR = {
  primary: rgb(0.11, 0.23, 0.40),
  text: rgb(0.13, 0.13, 0.15),
  muted: rgb(0.42, 0.44, 0.48),
  line: rgb(0.80, 0.82, 0.86),
  headerFill: rgb(0.90, 0.93, 0.97),
  zebra: rgb(0.97, 0.975, 0.985),
  red: rgb(0.72, 0.15, 0.15),
  amber: rgb(0.70, 0.45, 0.02),
  green: rgb(0.10, 0.50, 0.25),
};

// Standard PDF fonts only cover WinAnsi (Latin-1 plus a few symbols); other characters
// such as emoji are replaced so the PDF can always be produced.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
function safe(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").replace(/→/g, "->").replace(/[−]/g, "-")
    .replace(/./gu, (char) => {
      const code = char.codePointAt(0)!;
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char) ? char : "?";
    });
}

const number = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "-" : value.toLocaleString("id-ID", { maximumFractionDigits: 6 });

interface Column { header: string; width: number; align?: "left" | "right" | "center" }
interface Cell { text: string; color?: RGB; bold?: boolean }
type Row = (string | Cell)[];

class Layout {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly italic: PDFFont,
    readonly runningHeader: string,
  ) {}

  addPage(first = false): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
    if (!first) {
      this.text(this.runningHeader, MARGIN, this.y - 8, { size: 8, font: this.bold, color: COLOR.muted });
      this.page.drawLine({ start: { x: MARGIN, y: this.y - 13 }, end: { x: PAGE_WIDTH - MARGIN, y: this.y - 13 }, thickness: 0.5, color: COLOR.line });
      this.y -= 24;
    }
  }

  /** Starts a new page when fewer than `height` points remain above the footer. */
  ensure(height: number): boolean {
    if (this.y - height >= BOTTOM) return false;
    this.addPage();
    return true;
  }

  text(value: string, x: number, y: number, options: { size?: number; font?: PDFFont; color?: RGB } = {}): void {
    this.page.drawText(safe(value), { x, y, size: options.size ?? 9, font: options.font ?? this.regular, color: options.color ?? COLOR.text });
  }

  width(value: string, size: number, font = this.regular): number {
    return font.widthOfTextAtSize(safe(value), size);
  }

  /** Word-wraps into lines no wider than `max`; very long words are split. */
  wrap(value: string, max: number, size: number, font = this.regular): string[] {
    const words = safe(value).split(" ").filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (let word of words) {
      while (this.width(word, size, font) > max && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && this.width(word.slice(0, cut), size, font) > max) cut--;
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (this.width(candidate, size, font) <= max) line = candidate;
      else { if (line) lines.push(line); line = word; }
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  }

  sectionTitle(title: string): void {
    // Keep the title together with a table header and at least one row.
    this.ensure(70);
    this.y -= 8;
    this.text(title, MARGIN, this.y - 12, { size: 12, font: this.bold, color: COLOR.primary });
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 17 }, end: { x: PAGE_WIDTH - MARGIN, y: this.y - 17 }, thickness: 1, color: COLOR.primary });
    this.y -= 28;
  }

  paragraph(value: string, options: { size?: number; font?: PDFFont; color?: RGB } = {}): void {
    const size = options.size ?? 9;
    for (const line of this.wrap(value, CONTENT_WIDTH, size, options.font)) {
      this.ensure(size + 4);
      this.text(line, MARGIN, this.y - size, { ...options, size });
      this.y -= size + 4;
    }
  }

  /** A row of labelled figures, e.g. totals above a table. */
  stats(items: [string, string, RGB?][]): void {
    const gap = 8;
    const boxWidth = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
    this.ensure(44);
    items.forEach(([label, value, color], index) => {
      const x = MARGIN + index * (boxWidth + gap);
      this.page.drawRectangle({ x, y: this.y - 38, width: boxWidth, height: 38, color: COLOR.zebra, borderColor: COLOR.line, borderWidth: 0.5 });
      this.text(label, x + 8, this.y - 13, { size: 8, color: COLOR.muted });
      this.text(value, x + 8, this.y - 31, { size: 14, font: this.bold, color: color ?? COLOR.text });
    });
    this.y -= 50;
  }

  /** Draws a table; the header repeats on every page and rows are never split. */
  table(columns: Column[], rows: Row[], empty = "Tidak ada data pada periode ini."): void {
    const size = 7.5;
    const lineHeight = 9.5;
    const padding = 4;
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    const widths = columns.map((column) => (column.width / total) * CONTENT_WIDTH);
    const drawHeader = () => {
      const lines = columns.map((column, i) => this.wrap(column.header, widths[i] - padding * 2, size, this.bold));
      const height = Math.max(...lines.map((l) => l.length)) * lineHeight + padding * 2;
      this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height, color: COLOR.headerFill });
      let x = MARGIN;
      lines.forEach((cellLines, i) => {
        cellLines.forEach((line, n) => this.text(line, this.cellX(line, x, widths[i], padding, size, columns[i].align, this.bold), this.y - padding - (n + 1) * lineHeight + 2, { size, font: this.bold, color: COLOR.primary }));
        x += widths[i];
      });
      this.y -= height;
    };

    this.ensure(40);
    drawHeader();
    if (!rows.length) {
      this.text(empty, MARGIN + padding, this.y - padding - lineHeight + 2, { size, font: this.italic, color: COLOR.muted });
      this.y -= lineHeight + padding * 2;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness: 0.5, color: COLOR.line });
      this.y -= 10;
      return;
    }
    rows.forEach((row, index) => {
      const cells = row.map((cell) => (typeof cell === "string" ? { text: cell } : cell));
      const lines = cells.map((cell, i) => this.wrap(cell.text, widths[i] - padding * 2, size, cell.bold ? this.bold : this.regular));
      const height = Math.max(...lines.map((l) => l.length)) * lineHeight + padding * 2;
      if (this.ensure(height)) drawHeader();
      if (index % 2 === 1) this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height, color: COLOR.zebra });
      let x = MARGIN;
      lines.forEach((cellLines, i) => {
        const font = cells[i].bold ? this.bold : this.regular;
        cellLines.forEach((line, n) => this.text(line, this.cellX(line, x, widths[i], padding, size, columns[i].align, font), this.y - padding - (n + 1) * lineHeight + 2, { size, font, color: cells[i].color }));
        x += widths[i];
      });
      this.y -= height;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness: 0.3, color: COLOR.line });
    });
    this.y -= 10;
  }

  private cellX(line: string, x: number, width: number, padding: number, size: number, align: Column["align"], font: PDFFont): number {
    if (align === "right") return x + width - padding - this.width(line, size, font);
    if (align === "center") return x + (width - this.width(line, size, font)) / 2;
    return x + padding;
  }
}

const STATUS_COLOR = { Aman: COLOR.green, Menipis: COLOR.amber, Habis: COLOR.red } as const;

const TRANSACTION_COLUMNS: Column[] = [
  { header: "Tanggal", width: 9 }, { header: "ID Transaksi", width: 9 }, { header: "Barang", width: 26 },
  { header: "Quantity", width: 8, align: "right" }, { header: "Satuan", width: 7 }, { header: "User", width: 16 }, { header: "Keterangan", width: 25 },
];

/** Renders the monthly report as one PDF, however many pages the data needs. */
export async function generateReportPdf(report: MonthlyReport): Promise<GeneratedPdf> {
  const doc = await PDFDocument.create();
  const company = report.config.companyName.toUpperCase();
  doc.setTitle(`Laporan Stok & Transaksi ${report.period.label}`);
  doc.setAuthor(report.config.companyName);
  doc.setCreator(report.config.assistantName);
  doc.setProducer(report.config.assistantName);

  const layout = new Layout(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
    await doc.embedFont(StandardFonts.HelveticaOblique),
    `${company}  |  Laporan Stok & Transaksi  |  Periode ${report.period.label}`,
  );
  layout.addPage(true);

  // Cover header.
  layout.page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 104, width: PAGE_WIDTH, height: 104, color: COLOR.primary });
  layout.text(company, MARGIN, PAGE_HEIGHT - 42, { size: 18, font: layout.bold, color: rgb(1, 1, 1) });
  layout.text("LAPORAN STOK & TRANSAKSI", MARGIN, PAGE_HEIGHT - 62, { size: 12, font: layout.bold, color: rgb(0.85, 0.9, 1) });
  layout.text(`Periode: ${report.period.label}`, MARGIN, PAGE_HEIGHT - 80, { size: 10, color: rgb(1, 1, 1) });
  layout.text(`Generated by ${report.config.assistantName}`, MARGIN, PAGE_HEIGHT - 94, { size: 8, color: rgb(0.85, 0.9, 1) });
  const stamp = `Dibuat: ${report.generatedAt}`;
  layout.text(stamp, PAGE_WIDTH - MARGIN - layout.width(stamp, 8), PAGE_HEIGHT - 94, { size: 8, color: rgb(0.85, 0.9, 1) });
  layout.y = PAGE_HEIGHT - 104 - 14;

  // 1. Stock summary (current condition from the Stok sheet).
  layout.sectionTitle("1. RINGKASAN STOK");
  layout.stats([
    ["Total barang", number(report.stock.total)],
    ["Stok aman", number(report.stock.safe), COLOR.green],
    ["Stok menipis", number(report.stock.low), COLOR.amber],
    ["Stok habis", number(report.stock.out), COLOR.red],
  ]);
  layout.table(
    [{ header: "SKU", width: 10 }, { header: "Nama Barang", width: 34 }, { header: "Stok Akhir", width: 10, align: "right" },
      { header: "Satuan", width: 9 }, { header: "Stok Minimum", width: 11, align: "right" }, { header: "Status", width: 11 }, { header: "Lokasi Rak", width: 15 }],
    report.stock.rows.map((row) => [row.sku, row.name, number(row.stock), row.unit, number(row.minimum),
      { text: row.status, color: STATUS_COLOR[row.status], bold: true }, row.rack || "-"]),
    "Belum ada data barang.",
  );

  // 2 & 3. Goods in and out during the period.
  const transactionRows = (rows: MonthlyReport["incoming"]["rows"]): Row[] =>
    rows.map((entry) => [entry.dateText, entry.transactionId, `${entry.productName} (${entry.sku})`, number(entry.quantity), entry.unit, entry.user, entry.note || "-"]);
  layout.sectionTitle("2. BARANG MASUK");
  layout.stats([["Total item masuk", number(report.incoming.count)], ["Total quantity masuk", number(report.incoming.quantity)]]);
  layout.table(TRANSACTION_COLUMNS, transactionRows(report.incoming.rows));

  layout.sectionTitle("3. BARANG KELUAR");
  layout.stats([["Total item keluar", number(report.outgoing.count)], ["Total quantity keluar", number(report.outgoing.quantity)]]);
  layout.table(TRANSACTION_COLUMNS, transactionRows(report.outgoing.rows));

  // 4. Stock movement per product, computed from the history.
  layout.sectionTitle("4. PERGERAKAN STOK");
  layout.paragraph("Stok Akhir Periode = Stok Awal Periode + Barang Masuk - Barang Keluar + Adjustment (dihitung dari Riwayat Transaksi).", { size: 8, color: COLOR.muted });
  layout.y -= 4;
  layout.table(
    [{ header: "SKU", width: 10 }, { header: "Nama Barang", width: 30 }, { header: "Stok Awal Periode", width: 12, align: "right" },
      { header: "Barang Masuk", width: 11, align: "right" }, { header: "Barang Keluar", width: 11, align: "right" },
      { header: "Adjustment", width: 11, align: "right" }, { header: "Stok Akhir Periode", width: 12, align: "right" }],
    report.movements.map((row) => [row.sku, row.name, number(row.opening), number(row.incoming), number(row.outgoing),
      number(row.adjustment), { text: number(row.closing), bold: true }]),
  );
  if (report.discrepancies.length) {
    layout.paragraph("Catatan selisih (tidak diubah otomatis):", { size: 8, font: layout.bold, color: COLOR.amber });
    for (const note of report.discrepancies) layout.paragraph(`- ${note}`, { size: 8, color: COLOR.text });
    layout.y -= 6;
  }

  // 5. Purchases: only real records, none are invented.
  layout.sectionTitle("5. PEMBELIAN");
  layout.paragraph("Belum ada data pembelian yang tercatat pada periode ini.", { font: layout.italic, color: COLOR.muted });
  layout.y -= 6;

  // 6. Full transaction history of the period, newest first.
  layout.sectionTitle("6. RIWAYAT TRANSAKSI");
  layout.table(
    [{ header: "ID Transaksi", width: 7 }, { header: "Tanggal", width: 7 }, { header: "Waktu", width: 5 }, { header: "Jenis Transaksi", width: 7 },
      { header: "SKU", width: 7 }, { header: "Nama Barang", width: 15 }, { header: "Quantity", width: 6, align: "right" }, { header: "Satuan", width: 6 },
      { header: "Stok Sebelum", width: 7, align: "right" }, { header: "Stok Sesudah", width: 7, align: "right" }, { header: "User", width: 12 }, { header: "Keterangan", width: 14 }],
    report.history.map((entry) => [entry.transactionId, entry.dateText, entry.timeText, entry.typeLabel, entry.sku, entry.productName,
      number(entry.quantity), entry.unit, number(entry.stockBefore), number(entry.stockAfter), entry.user, entry.note || "-"]),
    "Belum ada transaksi yang tercatat pada periode ini.",
  );

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    layout.page = page;
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 14 }, end: { x: PAGE_WIDTH - MARGIN, y: MARGIN + 14 }, thickness: 0.5, color: COLOR.line });
    layout.text(`${report.config.companyName} - ${report.config.assistantName}  |  Dibuat ${report.generatedAt}`, MARGIN, MARGIN, { size: 7.5, color: COLOR.muted });
    const label = `Halaman ${index + 1} dari ${pages.length}`;
    layout.text(label, PAGE_WIDTH - MARGIN - layout.width(label, 7.5), MARGIN, { size: 7.5, color: COLOR.muted });
  });

  const bytes = await doc.save();
  return { filename: reportFileName(report), bytes, pageCount: pages.length };
}
