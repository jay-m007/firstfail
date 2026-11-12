// Collapsing the repeats. A failing CI log is mostly the same few lines over and over with
// different numbers in them, so each line is reduced to a shape and the shapes are counted.
// This is how 18,000 lines becomes "one real failure and 340 copies of its consequence".

import type { Line } from "./lines.ts";

export interface Cluster {
  /** The line with its variable parts replaced, which is what makes two lines "the same". */
  shape: string;
  /** Line numbers in the original file, in order. */
  lines: number[];
  /** The first line of this shape, as text, for showing. */
  example: string;
  count: number;
}

/**
 * Replaces the parts of a line that change between otherwise identical lines. Order matters:
 * the long, specific things go first so a timestamp is not eaten piecemeal by the number rule.
 */
export function shapeOf(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\b/g, "<time>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hex>")
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
    .replace(/[A-Za-z]:\\(?:[\w.@+-]+\\?)+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)+\b/g, "<version>")
    .replace(/\b\d+(?:\.\d+)?(ms|s|m|h|kb|mb|gb|%)\b/gi, "<measure>")
    .replace(/\b\d[\d,_]*\b/g, "<n>")
    .replace(/"[^"]{0,120}"/g, '"<s>"')
    .replace(/'[^']{0,120}'/g, "'<s>'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Groups lines by shape, keeping the order they first appeared in. */
export function cluster(lines: Line[]): Cluster[] {
  const byShape = new Map<string, Cluster>();
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const shape = shapeOf(l.text);
    if (!shape || shape.length < 2) continue;
    const existing = byShape.get(shape);
    if (existing) { existing.lines.push(l.n); existing.count++; }
    else byShape.set(shape, { shape, lines: [l.n], example: l.text.trim(), count: 1 });
  }
  return [...byShape.values()];
}

/** The shapes that take up the most room, which is what "noise" means in practice. */
export function noisiest(clusters: Cluster[], min = 3): Cluster[] {
  return clusters.filter((c) => c.count >= min).sort((a, b) => b.count - a.count);
}
