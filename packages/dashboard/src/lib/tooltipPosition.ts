/**
 * #266 follow-up: side-positioned marker tooltip math.
 *
 * Earlier all chart-marker tooltips opened below-right of the marker
 * with a viewport-only "flip when overflowing" fallback. That's fine
 * for a single chart but the dashboard stacks the hashrate chart on
 * top of the price chart - and a tooltip on a hashrate marker would
 * extend downward INTO the price chart, obscuring its data. (And vice
 * versa for a price-chart marker overlapping the hashrate chart
 * above.)
 *
 * This helper positions the tooltip to one SIDE of the marker (left
 * by default, right if there's no room left), vertically centred on
 * the marker. The tooltip then extends roughly equally above and
 * below the marker, which keeps it within the chart's own vertical
 * band in the common case where the marker is near the chart's
 * middle. We still clamp to the viewport as a last resort.
 *
 * Callers pass the marker's viewport-coordinate position (tip.x,
 * tip.y) and the tooltip's measured size (rect). The helper returns
 * absolute `left` / `top` viewport coordinates.
 */
export function sideTooltipPosition(
  tipX: number,
  tipY: number,
  rect: { width: number; height: number },
  opts?: { gap?: number; margin?: number },
): { left: number; top: number } {
  const gap = opts?.gap ?? 14;
  const margin = opts?.margin ?? 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer left side. If left side would overflow the viewport's left
  // edge (marker is near the left of the page), flip to the right.
  let left = tipX - rect.width - gap;
  if (left < margin) {
    const rightSide = tipX + gap;
    if (rightSide + rect.width <= vw - margin) {
      left = rightSide;
    } else {
      // Neither side fits cleanly; fall back to the margin nearer the
      // viewport edge that has more room.
      left = Math.max(margin, vw - rect.width - margin);
    }
  } else if (left + rect.width > vw - margin) {
    left = vw - rect.width - margin;
  }

  // Centred vertically on the marker; clamp within the viewport.
  let top = tipY - rect.height / 2;
  if (top + rect.height > vh - margin) top = vh - rect.height - margin;
  if (top < margin) top = margin;

  return { left, top };
}
