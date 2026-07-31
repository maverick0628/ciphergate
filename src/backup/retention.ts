/**
 * Backup retention planning — pure logic, no I/O.
 *
 * Offsite objects are keyed `<asset>/<YYYY-MM-DD>/<file>`. Retention is a
 * grandfather-father-son window over the *dates*: keep the newest `retainDaily`
 * dates, then one date per ISO week for the next `retainWeekly` weeks, prune the
 * rest. A pruned date drops *all* its keys together. Keys with no parseable date
 * (e.g. a `manifest/latest.json` pointer) are always kept — never auto-deleted.
 */

export interface RetentionPolicy {
  retainDaily: number;
  retainWeekly: number;
}

export interface RetentionPlan {
  keep: string[];
  prune: string[];
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Extract the YYYY-MM-DD a key belongs to, or null if it carries no date. */
export function keyDate(key: string): string | null {
  const m = key.match(DATE_RE);
  return m ? m[1] : null;
}

/**
 * ISO-8601 week id for a YYYY-MM-DD date, as `<isoYear>-W<ww>`. Weeks run
 * Monday–Sunday; the week-numbering year can differ from the calendar year at
 * the boundaries, so both are encoded to keep ids globally comparable.
 */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // Shift to the Thursday of this week — ISO weeks are numbered by their Thursday.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Decide which keys to keep and which to prune under the policy. Deterministic:
 * dates are ranked newest-first; within a week the newest date wins.
 */
export function planRetention(keys: string[], policy: RetentionPolicy): RetentionPlan {
  const undated: string[] = [];
  const byDate = new Map<string, string[]>();
  for (const key of keys) {
    const date = keyDate(key);
    if (!date) {
      undated.push(key);
      continue;
    }
    const list = byDate.get(date) ?? [];
    list.push(key);
    byDate.set(date, list);
  }

  const dates = [...byDate.keys()].sort().reverse(); // newest first
  const keepDates = new Set<string>();

  // 1. Daily window: newest N dates.
  const daily = dates.slice(0, Math.max(0, policy.retainDaily));
  daily.forEach((d) => keepDates.add(d));

  // 2. Weekly window: of the remaining older dates, keep the newest date in each
  //    ISO week, up to retainWeekly weeks.
  const remaining = dates.slice(daily.length);
  const seenWeeks = new Set<string>();
  for (const date of remaining) {
    if (seenWeeks.size >= Math.max(0, policy.retainWeekly) && !seenWeeks.has(isoWeek(date))) break;
    const week = isoWeek(date);
    if (!seenWeeks.has(week)) {
      if (seenWeeks.size >= Math.max(0, policy.retainWeekly)) continue;
      seenWeeks.add(week);
      keepDates.add(date); // newest date in this week (remaining is newest-first)
    }
  }

  const keep: string[] = [...undated];
  const prune: string[] = [];
  for (const [date, list] of byDate) {
    if (keepDates.has(date)) keep.push(...list);
    else prune.push(...list);
  }
  return { keep, prune };
}
