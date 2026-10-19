/** One page of a listing that continues from a cursor. */
interface Page<T, C> {
  readonly items: readonly T[];
  readonly next?: C | undefined;
}

/** Reads a listing page by page, keeping the items `keep` admits, until it ends or `enough` of them are kept. */
export async function drain<T, C>(
  page: (cursor: C | undefined) => Promise<Page<T, C>>,
  keep: (item: T) => boolean = () => true,
  enough = Infinity,
): Promise<T[]> {
  const kept: T[] = [];
  let cursor: C | undefined;
  do {
    const read = await page(cursor);
    kept.push(...read.items.filter(keep));
    cursor = read.next;
  } while (kept.length < enough && cursor !== undefined);
  return kept.slice(0, enough);
}
