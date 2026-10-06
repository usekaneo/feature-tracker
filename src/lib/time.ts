const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(date: Date, now = Date.now()): string {
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  for (const [unit, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      const short = unit === "minute" ? "m" : unit === "hour" ? "h" : unit === "day" ? "d" : unit === "week" ? "w" : unit === "month" ? "mo" : "y";
      return `${n}${short} ago`;
    }
  }
  return "just now";
}

const dateFormat = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export const formatDate = (date: Date) => dateFormat.format(date);
export const formatDateTime = (date: Date) => `${dateTimeFormat.format(date)} UTC`;
