const bkkDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });

export function bangkokDate(d: Date): string {
  return bkkDay.format(d);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every Bangkok calendar date touched by the half-open range [from, to). */
export function bangkokDatesBetween(from: Date, to: Date): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const last = bangkokDate(new Date(to.getTime() - 1));
  const out: string[] = [];
  for (let d = bangkokDate(from); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday … 6 = Saturday, for a Bangkok calendar date `YYYY-MM-DD`. */
export function bangkokWeekday(date: string): number {
  return new Date(`${date}T12:00:00+07:00`).getUTCDay();
}

/** Half-open overlap of [aFrom, aTo) and [bFrom, bTo). */
export function overlaps(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): boolean {
  return aFrom.getTime() < bTo.getTime() && bFrom.getTime() < aTo.getTime();
}
