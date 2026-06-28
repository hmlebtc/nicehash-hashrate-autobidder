/**
 * #257: crosshair snap-geometry tests. The math module is JSX- and
 * macro-free on purpose so these run without the Lingui babel
 * transform.
 */

import { describe, expect, it } from 'vitest';

import {
  clientXToTickAt,
  nearestTickIndex,
  type CrosshairGeometry,
} from './chartCrosshairMath.js';

describe('nearestTickIndex', () => {
  it('returns -1 on an empty array', () => {
    expect(nearestTickIndex([], 100)).toBe(-1);
  });

  it('returns 0 for a single-element array regardless of t', () => {
    expect(nearestTickIndex([50], 0)).toBe(0);
    expect(nearestTickIndex([50], 50)).toBe(0);
    expect(nearestTickIndex([50], 1e12)).toBe(0);
  });

  it('snaps to the nearest element', () => {
    const xs = [0, 10, 20, 30, 40];
    expect(nearestTickIndex(xs, -5)).toBe(0);
    expect(nearestTickIndex(xs, 4)).toBe(0);
    expect(nearestTickIndex(xs, 6)).toBe(1);
    expect(nearestTickIndex(xs, 14)).toBe(1);
    expect(nearestTickIndex(xs, 16)).toBe(2);
    expect(nearestTickIndex(xs, 39)).toBe(4);
    expect(nearestTickIndex(xs, 99)).toBe(4);
  });

  it('prefers the left neighbour on exact midpoints', () => {
    // Midpoint 15 is equidistant from 10 and 20 - the <= comparison
    // resolves to the earlier tick.
    expect(nearestTickIndex([0, 10, 20], 15)).toBe(1);
  });

  it('handles exact hits', () => {
    const xs = [100, 200, 300];
    expect(nearestTickIndex(xs, 200)).toBe(1);
    expect(nearestTickIndex(xs, 300)).toBe(2);
  });

  it('handles irregular spacing (bucketed long ranges)', () => {
    const xs = [0, 60_000, 120_000, 3_600_000];
    expect(nearestTickIndex(xs, 130_000)).toBe(2);
    expect(nearestTickIndex(xs, 3_000_000)).toBe(3);
  });
});

describe('clientXToTickAt', () => {
  // Mirror the charts' geometry: 880-wide viewBox, 80px left pad,
  // 16px right pad, rendered at 2x scale (1760 css px).
  const geom = (xs: number[], minX: number, maxX: number): CrosshairGeometry => ({
    width: 880,
    padLeft: 80,
    padRight: 16,
    minX,
    maxX,
    xs,
  });
  const svgAt = (left: number, width: number) => ({
    getBoundingClientRect: () =>
      ({ left, width, top: 0, height: 400, right: left + width, bottom: 400, x: left, y: 0, toJSON: () => ({}) }) as DOMRect,
  });

  it('maps the left data edge to the first tick and the right edge to the last', () => {
    const xs = [1000, 2000, 3000];
    const g = geom(xs, 1000, 3000);
    const svg = svgAt(0, 880); // 1:1 render
    expect(clientXToTickAt(svg, 80, g)).toBe(1000);
    expect(clientXToTickAt(svg, 880 - 16, g)).toBe(3000);
  });

  it('snaps interior positions to the nearest tick', () => {
    const xs = [0, 100, 200];
    const g = geom(xs, 0, 200);
    const svg = svgAt(0, 880);
    // Data region spans x = 80..864 (784 wide). 40% across = t = 80
    // which snaps to tick 100.
    expect(clientXToTickAt(svg, 80 + 784 * 0.4, g)).toBe(100);
    // 10% across = t = 20 → snaps to 0.
    expect(clientXToTickAt(svg, 80 + 784 * 0.1, g)).toBe(0);
  });

  it('returns null over the axis gutters', () => {
    const xs = [0, 100];
    const g = geom(xs, 0, 100);
    const svg = svgAt(0, 880);
    expect(clientXToTickAt(svg, 10, g)).toBeNull(); // left Y-axis gutter
    expect(clientXToTickAt(svg, 879, g)).toBeNull(); // right gutter
  });

  it('accounts for the rendered scale and page offset', () => {
    const xs = [0, 100, 200];
    const g = geom(xs, 0, 200);
    // Rendered at 2x and offset 100px into the page.
    const svg = svgAt(100, 1760);
    // ClientX for viewBox-x 472 (data-region midpoint): 100 + 472*2.
    expect(clientXToTickAt(svg, 100 + 472 * 2, g)).toBe(100);
  });

  it('returns null when the nearest tick lies outside the viewport', () => {
    // Viewport shows 100..200 but the only ticks sit before it.
    const xs = [0, 50];
    const g = geom(xs, 100, 200);
    const svg = svgAt(0, 880);
    expect(clientXToTickAt(svg, 400, g)).toBeNull();
  });

  it('returns null for a zero-width rect (unmounted svg)', () => {
    const xs = [0, 100];
    const g = geom(xs, 0, 100);
    expect(clientXToTickAt(svgAt(0, 0), 50, g)).toBeNull();
  });
});
