import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getFieldByRole } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

export interface TrackerTagOption {
  name: string;
  count: number;
}

export function normalizeTrackerTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

export function getTrackerItemTags(item: TrackerRecord): string[] {
  return normalizeTrackerTagList(getFieldByRole(item, 'tags'));
}

export function buildTrackerTagOptions(items: TrackerRecord[]): TrackerTagOption[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const uniqueTags = new Set(getTrackerItemTags(item));
    for (const tag of uniqueTags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
}

export function filterTrackerItemsByTags(items: TrackerRecord[], activeTags: string[]): TrackerRecord[] {
  if (activeTags.length === 0) return items;

  const activeSet = new Set(activeTags);
  return items.filter((item) => getTrackerItemTags(item).some((tag) => activeSet.has(tag)));
}
