// Host-local date helpers. All memory dates use host-local time at
// minute precision (YYYY/MM/DD HH:MM), matching the skill's format.

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** YYYY/MM/DD in host-local time. */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** HH:MM in host-local time. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM in host-local time. */
export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Parse a YYYY/MM/DD date heading back to an epoch ms (local midnight). */
export function parseDateHeading(date: string): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(date.trim());
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
  ).getTime();
}

/** Whole days between ts and now. */
export function ageDays(ts: number, now: number): number {
  return Math.max(0, (now - ts) / 86_400_000);
}
