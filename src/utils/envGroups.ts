import { createHash } from "node:crypto";
import type { EnvLocation } from "./envInventory.js";

export type MatchKind = "exact" | "prefix" | "suffix";

export interface Occurrence extends EnvLocation {
  key: string;
  /** The value, used here only to compare; it must never leave the server. */
  value: string;
  src?: string | undefined;
  exp?: string | undefined;
}

export interface ValueGroup {
  matchedBy: MatchKind[];
  members: Occurrence[];
}

/** A short stable id that tells two values apart without revealing them. */
export function valueId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/**
 * Groups variables that hold the same value, or share their first or last `span` characters
 * (a rotated key often keeps its prefix). Values shorter than `span` only match exactly.
 * Groups of a single variable are dropped.
 */
export function groupBySharedValue(items: Occurrence[], span = 10): ValueGroup[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    parent[i] = root;
    return root;
  };

  const seenKey = new Map<string, number>();
  const kindOf = (id: string): MatchKind => id.slice(0, id.indexOf(":")) as MatchKind;
  const shared = new Map<string, number>();
  items.forEach((item, i) => {
    const ids = [`exact:${item.value}`];
    if (item.value.length >= span) {
      ids.push(`prefix:${item.value.slice(0, span)}`, `suffix:${item.value.slice(-span)}`);
    }
    for (const id of ids) {
      shared.set(id, (shared.get(id) ?? 0) + 1);
      const first = seenKey.get(id);
      if (first === undefined) seenKey.set(id, i);
      else parent[find(i)] = find(first);
    }
  });

  const groups = new Map<number, { members: Occurrence[]; kinds: Set<MatchKind> }>();
  items.forEach((item, i) => {
    const entry = groups.get(find(i)) ?? { members: [], kinds: new Set<MatchKind>() };
    entry.members.push(item);
    groups.set(find(i), entry);
  });
  for (const [id, count] of shared) {
    const root = find(seenKey.get(id) as number);
    if (count > 1) groups.get(root)?.kinds.add(kindOf(id));
  }

  return [...groups.values()]
    .filter((g) => g.members.length > 1)
    .map((g) => ({ matchedBy: [...g.kinds], members: g.members }))
    .sort((a, b) => b.members.length - a.members.length);
}
