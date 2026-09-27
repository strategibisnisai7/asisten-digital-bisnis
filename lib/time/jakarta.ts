import { TIME_ZONE } from "../config/app";

export interface CalendarDate { year: number; month: number; day: number }
export interface JakartaDateTime extends CalendarDate { hour: number; minute: number; second: number }

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** Wall-clock date and time in Asia/Jakarta for an instant. */
export function jakartaDateTime(at: Date): JakartaDateTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** 27/09/2026 */
export function formatDate(date: CalendarDate): string {
  return `${pad(date.day)}/${pad(date.month)}/${date.year}`;
}

/** 10:15 */
export function formatTime(time: Pick<JakartaDateTime, "hour" | "minute">): string {
  return `${pad(time.hour)}:${pad(time.minute)}`;
}

/** 27 September 2026 */
export function formatLongDate(date: CalendarDate): string {
  return `${date.day} ${MONTHS[date.month - 1]} ${date.year}`;
}

export interface MonthPeriod {
  /** 2026-09, used in file names. */
  key: string;
  start: CalendarDate;
  end: CalendarDate;
  label: string;
}

/** The calendar month containing `now` in Asia/Jakarta, first to last day. */
export function currentMonthPeriod(now: Date): MonthPeriod {
  const { year, month } = jakartaDateTime(now);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = { year, month, day: 1 };
  const end = { year, month, day: lastDay };
  return { key: `${year}-${pad(month)}`, start, end, label: `${formatLongDate(start)} – ${formatLongDate(end)}` };
}

export function sameMonth(date: CalendarDate, period: MonthPeriod): boolean {
  return date.year === period.start.year && date.month === period.start.month;
}
