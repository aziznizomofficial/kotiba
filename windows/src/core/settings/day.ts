// Local-day bucketing for the History pane.
//
// PURE. `Intl` is ECMAScript, not an operating system.
//
// D-W10 names this as one of exactly TWO places a Windows port differs silently — the
// other is path building — and it is on this list for a specific reason: every stored
// timestamp is ISO-8601 UTC, and the obvious way to group by day is to slice the first
// ten characters off it. That is correct in London in winter and wrong everywhere else.
// For the audience this app was built for (UTC+5, Tashkent) a dictation at 22:00 local
// is stored as 17:00 the same day, so the slice happens to agree — and a dictation at
// 03:00 local is stored as 22:00 THE PREVIOUS DAY, so it lands in yesterday's group
// while the user is still awake in today.

/** The IANA zone the app groups by. `undefined` means the host's own zone. */
export type TimeZone = string | undefined;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: TimeZone): Intl.DateTimeFormat {
  const cacheKey = timeZone ?? '';
  const existing = formatters.get(cacheKey);
  if (existing !== undefined) return existing;

  // `en-CA` yields YYYY-MM-DD, which sorts lexicographically and needs no reassembly.
  // The explicit 2-digit parts are not redundant: without them a single-digit month
  // renders unpadded in some locales and the keys stop sorting.
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatters.set(cacheKey, made);
  return made;
}

/**
 * The local calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * Throws nothing: an unparseable timestamp returns the empty string, because a history
 * row with a corrupt date must still be listable — dropping it would lose the text,
 * which is the only part the user cares about.
 */
export function localDayKey(iso: string, timeZone?: TimeZone): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return formatter(timeZone).format(at);
}

/**
 * Group entries by local day, preserving the order they arrive in within each day.
 *
 * Returns days newest-first when the input is newest-first, which is what `recent()`
 * hands over — the grouping does not re-sort, so a caller that wants a different order
 * sorts before calling rather than discovering a hidden one here.
 */
export function groupByLocalDay<T>(
  entries: readonly T[],
  at: (entry: T) => string,
  timeZone?: TimeZone,
): readonly { readonly day: string; readonly entries: readonly T[] }[] {
  const days = new Map<string, T[]>();
  for (const entry of entries) {
    const key = localDayKey(at(entry), timeZone);
    const bucket = days.get(key);
    if (bucket === undefined) days.set(key, [entry]);
    else bucket.push(entry);
  }
  return [...days].map(([day, group]) => ({ day, entries: group }));
}
