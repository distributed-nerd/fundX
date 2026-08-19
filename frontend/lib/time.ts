const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Compact age for list rows: "Just now", "12m", "3h", "Yesterday", "18 Aug". */
export function relativeTime(iso: string): string {
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();

  if (diff < MINUTE) return "Just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;

  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / DAY);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d`;

  return then.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Section heading for grouped history: "Today", "Yesterday", "18 August". */
export function dayLabel(iso: string): string {
  const then = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / DAY);

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";

  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(then.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Clock time only: "14:20". Used where a day heading already gives the date. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full stamp for a receipt: "19 August 2026 at 10:42". */
export function fullTime(iso: string): string {
  const then = new Date(iso);
  const date = then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = then.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} at ${time}`;
}
