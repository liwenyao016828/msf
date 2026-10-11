export const LOG_LIMIT = 1000;

export interface LogCursor {
  epoch: string;
  revision: number;
}

export function isLogCursor(value: unknown): value is LogCursor {
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as Partial<LogCursor>;
  return typeof cursor.epoch === "string" && cursor.epoch.length > 0 &&
    Number.isSafeInteger(cursor.revision) && Number(cursor.revision) >= 0;
}

export interface PendingLogRow<T> {
  id: string;
  row: T;
  cursor: LogCursor;
}

export function mergeLogRows<T extends { id: string }>(
  current: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return current;
  const ids = new Set(current.map((row) => row.id));
  const added: T[] = [];
  for (const row of incoming) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    added.push(row);
  }
  return added.length === 0
    ? current
    : [...current, ...added].slice(-LOG_LIMIT);
}

export function reconcileLogSnapshot<T extends { id: string }>(
  current: T[],
  snapshot: T[],
  pending: PendingLogRow<T>[],
  cursor: LogCursor,
): T[] {
  const newer = pending
    .filter(
      (item) =>
        item.cursor.epoch === cursor.epoch &&
        item.cursor.revision > cursor.revision,
    )
    .map((item) => item.row);
  const next = mergeLogRows(mergeLogRows<T>([], snapshot), newer);
  return current.length === next.length &&
    current.every((row, index) => row.id === next[index].id)
    ? current
    : next;
}
