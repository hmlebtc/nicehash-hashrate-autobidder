// #280: per-chart series visibility. Clicking a legend chip hides or
// shows that series (Chart.js / Bitaxe-UI idiom), so the operator can
// declutter a crowded chart and isolate one line. The hidden set is
// persisted per-device in localStorage - keyed per chart - matching
// how the right-axis selection and card order already persist, so a
// muted noisy series stays muted across reloads on that device.

import { useCallback, useEffect, useState } from 'react';

function readHidden(storageKey: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export interface SeriesVisibility {
  /** Set of currently-hidden series keys. */
  readonly hidden: ReadonlySet<string>;
  /** True when `key` is hidden (series should not render / Y-axis skips it). */
  readonly isHidden: (key: string) => boolean;
  /** Flip the hidden state of `key`. */
  readonly toggle: (key: string) => void;
}

export function useSeriesVisibility(storageKey: string): SeriesVisibility {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => readHidden(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...hidden]));
    } catch {
      /* localStorage unavailable (private mode / quota) - non-fatal,
         visibility just won't persist this session. */
    }
  }, [storageKey, hidden]);

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isHidden = useCallback((key: string) => hidden.has(key), [hidden]);

  return { hidden, isHidden, toggle };
}
