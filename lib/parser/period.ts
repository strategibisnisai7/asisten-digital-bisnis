/**
 * Time periods in Indonesian chat. Parsing is pure and clock-free; resolving a period
 * to calendar dates takes "today" (Asia/Jakarta) as an argument.
 */
import type { CalendarDate } from "../time/jakarta";

export type PeriodSpec =
  | { kind: "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "this_year" }
  | { kind: "last_days"; days: number }
  /** Months are 1–12; a missing month or year means "the current one". */
  | { kind: "range"; from: PartialDate; to: PartialDate };

export interface PartialDate { day: number; month?: number; year?: number }

export interface ResolvedPeriod { start: CalendarDate; end: CalendarDate; label: string }

const MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus", "september", "oktober", "november", "desember"];
const MONTH_ALIASES: Record<string, number> = Object.fromEntries([
  ...MONTHS.map((name, index) => [name, index + 1]),
  ...["jan", "feb", "mar", "apr", "mei", "jun", "jul", "agu", "agt", "ags", "sep", "sept", "okt", "nov", "des"]
    .map((name) => [name, { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6, jul: 7, agu: 8, agt: 8, ags: 8, sep: 9, sept: 9, okt: 10, nov: 11, des: 12 }[name]!]),
]);
const MONTH_NAME = `(?:${Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length).join("|")})`;

const FIXED: [RegExp, PeriodSpec][] = [
  [/(?:^|\s)(?:hari\s+ini|hr\s+ini|today)$/, { kind: "today" }],
  [/(?:^|\s)(?:kemarin|kemaren|kmrn|kmarin)$/, { kind: "yesterday" }],
  [/(?:^|\s)(?:minggu|pekan)\s+ini$/, { kind: "this_week" }],
  [/(?:^|\s)(?:minggu|pekan)\s+(?:lalu|kemarin|kemaren)$/, { kind: "last_week" }],
  [/(?:^|\s)bulan\s+ini$/, { kind: "this_month" }],
  [/(?:^|\s)bulan\s+(?:lalu|kemarin|kemaren)$/, { kind: "last_month" }],
  [/(?:^|\s)tahun\s+ini$/, { kind: "this_year" }],
];

// "1/9", "01/09/2026", "1 september", "1 sep 2026", or a bare day "1".
const DATE = String.raw`(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}))?|\s+(${MONTH_NAME})(?:\s+(\d{4}))?)?`;
const RANGE = new RegExp(String.raw`(?:^|\s)(?:dari\s+)?(?:tanggal|tgl\.?\s*)?\s*${DATE}\s*(?:-|–|sampai dengan|sampai|s\/d|sd|hingga)\s*(?:tanggal|tgl\.?\s*)?\s*${DATE}$`);
const SINGLE = new RegExp(String.raw`(?:^|\s)(?:pada\s+)?(?:tanggal|tgl\.?)\s*${DATE}$|(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$|(?:^|\s)(\d{1,2})\s+(${MONTH_NAME})(?:\s+(\d{4}))?$`);
const LAST_DAYS = /(?:^|\s)(\d{1,3})\s+hari\s+(?:terakhir|belakangan)$/;

function partial(day?: string, month?: string, year?: string, monthName?: string, yearAfterName?: string): PartialDate | null {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  const m = month ? Number(month) : monthName ? MONTH_ALIASES[monthName] : undefined;
  if (m !== undefined && (!Number.isInteger(m) || m < 1 || m > 12)) return null;
  const y = year ?? yearAfterName;
  return { day: d, ...(m ? { month: m } : {}), ...(y ? { year: Number(y) } : {}) };
}

/**
 * Finds a period at the END of the text and returns it with the text before it.
 * "barang masuk kemarin" → { rest: "barang masuk", period: yesterday }.
 */
export function extractPeriod(text: string): { rest: string; period: PeriodSpec } | null {
  for (const [pattern, period] of FIXED) {
    const match = text.match(pattern);
    if (match) return { rest: text.slice(0, match.index).trim(), period };
  }
  const days = text.match(LAST_DAYS);
  if (days && Number(days[1]) >= 1 && Number(days[1]) <= 366) {
    return { rest: text.slice(0, days.index).trim(), period: { kind: "last_days", days: Number(days[1]) } };
  }
  const range = text.match(RANGE);
  if (range) {
    const from = partial(range[1], range[2], range[3], range[4], range[5]);
    const to = partial(range[6], range[7], range[8], range[9], range[10]);
    // A bare "5 - 10" is only a range when "tanggal"/"dari" or a month makes it a date.
    const dated = /(?:tanggal|tgl|\/)/.test(range[0]) || range[4] || range[9];
    if (from && to && dated) {
      // "1 - 15 september": the month written once applies to both ends.
      const fromFilled = { ...from, month: from.month ?? to.month, year: from.year ?? to.year };
      return { rest: text.slice(0, range.index).trim().replace(/\s+(?:dari|periode)$/, ""), period: { kind: "range", from: fromFilled, to } };
    }
  }
  const single = text.match(SINGLE);
  if (single) {
    const date = single[1] ? partial(single[1], single[2], single[3], single[4], single[5])
      : single[6] ? partial(single[6], single[7], single[8])
        : partial(single[9], undefined, undefined, single[10], single[11]);
    if (date) return { rest: text.slice(0, single.index).trim(), period: { kind: "range", from: date, to: date } };
  }
  return null;
}

// ---------------------------------------------------------------- resolving

const toUtc = (date: CalendarDate) => Date.UTC(date.year, date.month - 1, date.day);
function fromUtc(ms: number): CalendarDate {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
const addDays = (date: CalendarDate, days: number) => fromUtc(toUtc(date) + days * 86_400_000);
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, "0");
const short = (date: CalendarDate) => `${pad(date.day)}/${pad(date.month)}/${date.year}`;

function complete(date: PartialDate, today: CalendarDate): CalendarDate | null {
  const year = date.year ?? today.year;
  const month = date.month ?? today.month;
  if (date.day > lastDayOf(year, month)) return null;
  return { year, month, day: date.day };
}

/** Calendar dates (inclusive) for a period, given today's date in Asia/Jakarta. Null when invalid. */
export function resolvePeriod(period: PeriodSpec, today: CalendarDate): ResolvedPeriod | null {
  switch (period.kind) {
    case "today": return { start: today, end: today, label: `hari ini (${short(today)})` };
    case "yesterday": {
      const day = addDays(today, -1);
      return { start: day, end: day, label: `kemarin (${short(day)})` };
    }
    case "this_week":
    case "last_week": {
      // Weeks run Monday to Sunday.
      const weekday = (new Date(toUtc(today)).getUTCDay() + 6) % 7;
      const monday = addDays(today, -weekday - (period.kind === "last_week" ? 7 : 0));
      const end = period.kind === "this_week" ? today : addDays(monday, 6);
      return { start: monday, end, label: `${period.kind === "this_week" ? "minggu ini" : "minggu lalu"} (${short(monday)} – ${short(end)})` };
    }
    case "this_month": {
      const start = { year: today.year, month: today.month, day: 1 };
      return { start, end: today, label: `bulan ini (${short(start)} – ${short(today)})` };
    }
    case "last_month": {
      const year = today.month === 1 ? today.year - 1 : today.year;
      const month = today.month === 1 ? 12 : today.month - 1;
      const start = { year, month, day: 1 };
      const end = { year, month, day: lastDayOf(year, month) };
      return { start, end, label: `bulan lalu (${short(start)} – ${short(end)})` };
    }
    case "this_year": {
      const start = { year: today.year, month: 1, day: 1 };
      return { start, end: today, label: `tahun ini (${short(start)} – ${short(today)})` };
    }
    case "last_days": {
      const start = addDays(today, -(period.days - 1));
      return { start, end: today, label: `${period.days} hari terakhir (${short(start)} – ${short(today)})` };
    }
    case "range": {
      const start = complete(period.from, today);
      const end = complete(period.to, today);
      if (!start || !end || toUtc(start) > toUtc(end)) return null;
      return { start, end, label: toUtc(start) === toUtc(end) ? short(start) : `${short(start)} – ${short(end)}` };
    }
  }
}

export function inPeriod(date: CalendarDate | null, period: Pick<ResolvedPeriod, "start" | "end">): boolean {
  return date !== null && toUtc(date) >= toUtc(period.start) && toUtc(date) <= toUtc(period.end);
}
