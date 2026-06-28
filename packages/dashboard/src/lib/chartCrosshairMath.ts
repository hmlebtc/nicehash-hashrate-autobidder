/**
 * #257: pure geometry/snap helpers for the chart crosshair. Kept free
 * of JSX and Lingui macros so vitest can import them without the
 * babel macro transform (same reason i18n.test.ts reads compiled
 * catalogs instead of macros).
 */

/** Binary-search the ascending `xs` array for the index nearest `t`.
 *  Returns -1 on an empty array. */
export function nearestTickIndex(xs: ArrayLike<number>, t: number): number {
  const n = xs.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index with xs[lo] >= t; the nearest is either it
  // or its left neighbour.
  if (lo > 0 && Math.abs(xs[lo - 1]! - t) <= Math.abs(xs[lo]! - t)) return lo - 1;
  return lo;
}

export interface CrosshairGeometry {
  /** SVG viewBox width (the charts' WIDTH constant). */
  width: number;
  padLeft: number;
  padRight: number;
  /** Visible data-space range (the shared viewport). */
  minX: number;
  maxX: number;
  /** Ascending tick timestamps to snap to. */
  xs: ReadonlyArray<number>;
}

/**
 * Convert a pointer clientX into the nearest snapped tick timestamp,
 * or null when the pointer sits outside the data region (over the
 * axis gutters). Geometry mirrors useChartViewport's padding math:
 * the rendered SVG preserves the viewBox aspect, so viewBox-x is a
 * plain proportion of the bounding rect.
 */
export function clientXToTickAt(
  svg: Pick<SVGSVGElement, 'getBoundingClientRect'>,
  clientX: number,
  geom: CrosshairGeometry,
): number | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const xView = ((clientX - rect.left) / rect.width) * geom.width;
  const usable = geom.width - geom.padLeft - geom.padRight;
  if (usable <= 0) return null;
  // 4 viewBox-units of forgiveness on either edge so the first/last
  // tick stays reachable.
  if (xView < geom.padLeft - 4 || xView > geom.width - geom.padRight + 4) return null;
  const frac = Math.max(0, Math.min(1, (xView - geom.padLeft) / usable));
  const t = geom.minX + frac * (geom.maxX - geom.minX);
  const idx = nearestTickIndex(geom.xs, t);
  if (idx < 0) return null;
  const snapped = geom.xs[idx]!;
  // Don't snap to a tick that's scrolled outside the viewport (can
  // happen near the edges when the data extends past the view).
  if (snapped < geom.minX || snapped > geom.maxX) return null;
  return snapped;
}
