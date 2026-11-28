import { useRef, useState } from 'react';

export type Versions = Record<string, number>;
type Apply = (versions: Versions) => Promise<Versions>;
type Entry = { before: Versions; after: Versions; undo: Apply; redo: Apply };
type History = { scope: string; position: number; entries: Entry[]; applying: boolean };
const limit = 50;

function rebase(entries: Entry[], boundary: 'before' | 'after', previous: Versions, updated: Versions) {
  const pending = new Set(Object.keys(updated));
  for (const entry of entries) {
    for (const id of pending) {
      const versions = entry[boundary];
      if (!(id in versions)) continue;
      // A version gap means another writer changed this entity in between.
      if (versions[id] === previous[id]) versions[id] = updated[id]!;
      pending.delete(id);
    }
    if (!pending.size) break;
  }
}

export function useCommandHistory(scope: string, onError: (error: string) => void) {
  const ref = useRef<History>({ scope, position: 0, entries: [], applying: false });
  const [, redraw] = useState(0);
  const refresh = () => redraw((version) => version + 1);
  if (ref.current.scope !== scope) ref.current = { scope, position: 0, entries: [], applying: false };
  const history = ref.current;

  function record(entry: Entry) {
    if (ref.current !== history || history.applying) return;
    history.entries = [...history.entries.slice(0, history.position), entry].slice(-limit);
    history.position = history.entries.length;
    refresh();
  }

  async function apply(direction: 'undo' | 'redo') {
    if (ref.current !== history || history.applying) return;
    const index = direction === 'undo' ? history.position - 1 : history.position;
    const entry = history.entries[index];
    if (!entry) return;
    history.applying = true;
    refresh();
    try {
      const updated = await entry[direction](direction === 'undo' ? entry.after : entry.before);
      if (ref.current !== history) return;
      if (direction === 'undo') {
        rebase(history.entries.slice(0, index).reverse(), 'after', entry.before, updated);
        entry.before = updated;
        history.position--;
      } else {
        rebase(history.entries.slice(index + 1), 'before', entry.after, updated);
        entry.after = updated;
        history.position++;
      }
    } catch (error) {
      if (ref.current === history) onError((error as Error).message);
    } finally {
      history.applying = false;
      if (ref.current === history) refresh();
    }
  }

  return {
    record, apply,
    isCurrent: () => ref.current === history,
    canUndo: !history.applying && history.position > 0,
    canRedo: !history.applying && history.position < history.entries.length,
  };
}

export const versionsOf = (entities: { id: string; version: number }[]): Versions =>
  Object.fromEntries(entities.map(({ id, version }) => [id, version]));

export function pickChanged<T extends object>(value: T, patch: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.keys(patch).map((key) => [key, value[key as keyof T]])) as Partial<T>;
}
