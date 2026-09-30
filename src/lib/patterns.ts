import { hashSeed, mulberry32 } from "./shuffle";

/**
 * Procedural texture tiles that tell option cards apart. Each seed picks a
 * family (stepping through FAMILIES, so consecutive seeds never share one);
 * each pass through the families (`cycle`) steps that family's spacing to a
 * new value, and seeded parameters (angle, mark size, weight, strength) vary
 * the rest. Marks are small and far apart, so the textures stay sparse.
 * Tiles are drawn in black and used as a CSS mask over an ink layer, so the
 * app decides the color and opacity. Every texture is canted by CANT_DEGREES:
 * the tile fills an SVG <pattern> rotated by that angle, painted over one
 * canvas larger than any card (a rotated tile can't repeat seamlessly on its
 * own, but a rotated <pattern> can).
 */

const CANT_DEGREES = 33;
const CANVAS = { width: 2000, height: 600 };

type Tile = { width: number; height: number; body: string };
type Family = (random: () => number, spacing: (min: number, max: number) => number, seed: number) => Tile;

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const between = (random: () => number, min: number, max: number) => +(min + random() * (max - min)).toFixed(2);

const stroke = (width: number) => `fill='none' stroke='#000' stroke-width='${width}'`;

const FAMILIES: Family[] = [
  // Pinstripes: vertical, horizontal, or either diagonal (built so the tile repeats seamlessly).
  (random, spacing) => {
    const s = spacing(24, 48);
    const width = between(random, 0.5, 0.9);
    const direction = pick(random, ["vertical", "horizontal", "rising", "falling"] as const);
    const path = {
      vertical: `M${s / 2} 0V${s}`,
      horizontal: `M0 ${s / 2}H${s}`,
      rising: `M0 ${s}L${s} 0M${-s / 2} ${s / 2}L${s / 2} ${-s / 2}M${s / 2} ${s * 1.5}L${s * 1.5} ${s / 2}`,
      falling: `M0 0L${s} ${s}M${-s / 2} ${s / 2}L${s / 2} ${s * 1.5}M${s / 2} ${-s / 2}L${s * 1.5} ${s / 2}`
    }[direction];
    return { width: s, height: s, body: `<path d='${path}' ${stroke(width)}/>` };
  },
  // Polka dots on a square grid.
  (random, spacing) => {
    const size = spacing(28, 52);
    const radius = between(random, 0.8, 1.4);
    return { width: size, height: size, body: `<circle cx='${size / 2}' cy='${size / 2}' r='${radius}'/>` };
  },
  // Diamonds: small outlined or filled rhombi.
  (random, spacing) => {
    const size = spacing(32, 56);
    const half = between(random, 1.5, 2.6);
    const filled = random() < 0.5;
    const c = size / 2;
    return { width: size, height: size, body: `<path d='M${c} ${c - half}L${c + half} ${c}L${c} ${c + half}L${c - half} ${c}Z' ${filled ? "" : stroke(0.7)}/>` };
  },
  // Sparse speckle: a different turbulence per seed, thresholded to scattered grains.
  (random, _spacing, seed) => {
    const frequency = between(random, 0.6, 1.1);
    const body = `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='2' seed='${seed}' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 6 -4.1'/></filter><rect width='200' height='200' filter='url(#n)'/>`;
    return { width: 200, height: 200, body };
  },
  // Offset (staggered) dots.
  (random, spacing) => {
    const size = spacing(36, 60);
    const radius = between(random, 0.7, 1.2);
    const q = size / 4;
    return { width: size, height: size, body: `<circle cx='${q}' cy='${q}' r='${radius}'/><circle cx='${q * 3}' cy='${q * 3}' r='${radius}'/>` };
  },
  // Chevrons (zigzag rows), with room between rows.
  (random, spacing) => {
    const width = spacing(28, 52);
    const height = Math.round(width * between(random, 0.7, 1));
    const weight = between(random, 0.5, 0.9);
    const rise = height * 0.3;
    return { width, height, body: `<path d='M0 ${height / 2 + rise / 2}L${width / 2} ${height / 2 - rise / 2}L${width} ${height / 2 + rise / 2}' ${stroke(weight)}/>` };
  },
  // Open square grid lines.
  (random, spacing) => {
    const size = spacing(32, 56);
    const weight = between(random, 0.4, 0.7);
    return { width: size, height: size, body: `<path d='M0 0.5H${size}M0.5 0V${size}' ${stroke(weight)}/>` };
  },
  // Gentle waves, widely spaced rows.
  (random, spacing) => {
    const width = spacing(40, 64);
    const height = Math.round(between(random, 22, 32));
    const amplitude = between(random, 1.2, 2.2);
    const mid = height / 2;
    const weight = between(random, 0.5, 0.9);
    const path = `M0 ${mid}C${width / 4} ${mid - amplitude} ${width / 4} ${mid - amplitude} ${width / 2} ${mid}S${(width * 3) / 4} ${mid + amplitude} ${width} ${mid}`;
    return { width, height, body: `<path d='${path}' ${stroke(weight)}/>` };
  },
  // Rings.
  (random, spacing) => {
    const size = spacing(32, 56);
    const radius = between(random, 1.6, 2.6);
    return { width: size, height: size, body: `<circle cx='${size / 2}' cy='${size / 2}' r='${radius}' ${stroke(0.9)}/>` };
  },
  // Tiny squares, upright or turned 45°.
  (random, spacing) => {
    const size = spacing(28, 52);
    const half = between(random, 1, 1.7);
    const c = size / 2;
    const body = random() < 0.5
      ? `<rect x='${c - half}' y='${c - half}' width='${half * 2}' height='${half * 2}'/>`
      : `<path d='M${c} ${c - half * 1.3}L${c + half * 1.3} ${c}L${c} ${c + half * 1.3}L${c - half * 1.3} ${c}Z'/>`;
    return { width: size, height: size, body };
  },
  // Small crosses.
  (random, spacing) => {
    const size = spacing(32, 56);
    const arm = between(random, 1.3, 2.1);
    const c = size / 2;
    return { width: size, height: size, body: `<path d='M${c - arm} ${c}H${c + arm}M${c} ${c - arm}V${c + arm}' ${stroke(0.9)}/>` };
  }
];

/** Which family a seed uses: consecutive seeds always differ. */
export function patternFamily(seed: number): number {
  return ((seed % FAMILIES.length) + FAMILIES.length) % FAMILIES.length;
}

/** A CSS `url(...)` for the seed's tile, to use as a mask-image. */
export function optionPattern(seed: number): string {
  const random = mulberry32(hashSeed(`option-pattern:${seed}`));
  const family = FAMILIES[patternFamily(seed)] as Family;
  // Each pass through the families moves to the next spacing, so a family
  // never repeats its spacing within (max - min + 1) passes.
  const cycle = Math.floor(Math.max(0, seed) / FAMILIES.length);
  const spacing = (min: number, max: number) => min + (cycle % (max - min + 1));
  const { width, height, body } = family(random, spacing, seed);
  // A seeded ink strength per tile: one more dimension of variety.
  const strength = between(random, 0.6, 1);
  const tile = `<pattern id='p' width='${width}' height='${height}' patternUnits='userSpaceOnUse' patternTransform='rotate(${CANT_DEGREES})'><g opacity='${strength}'>${body}</g></pattern>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${CANVAS.width}' height='${CANVAS.height}'><defs>${tile}</defs><rect width='${CANVAS.width}' height='${CANVAS.height}' fill='url(#p)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replaceAll("#", "%23").replaceAll("<", "%3C").replaceAll(">", "%3E")}")`;
}

export const PATTERN_FAMILY_COUNT = FAMILIES.length;
