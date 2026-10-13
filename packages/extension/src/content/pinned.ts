/**
 * "Pinned" elements (position: fixed or sticky) and how to hide them during
 * a full-page capture. Pure logic, no DOM globals, so it is unit-tested; the
 * page helper supplies the real elements and computed styles.
 *
 * Why hide them: a full-page screenshot is stitched from viewport captures
 * taken at different scroll positions. A fixed header is on screen in every
 * one of them, so without this it would appear once per tile. We leave the
 * first tile untouched (header appears once, at the top) and hide pinned
 * elements for every later tile.
 *
 * `visibility: hidden` (not `display: none`) keeps the layout identical, so
 * nothing shifts between tiles. It is set inline with `!important` so page
 * stylesheets can't override it, and the previous inline value/priority is
 * remembered so restoring leaves the element exactly as we found it.
 *
 * Known gaps (documented in the README):
 *  - Sticky elements that are not stuck yet (e.g. a sticky table header
 *    further down) are hidden too, so they are missing from later tiles.
 *  - A pinned element's descendant with an explicit `visibility: visible`
 *    stays visible.
 *  - Elements inside shadow roots are not scanned.
 *  - The scan stops after PINNED_SCAN_LIMIT elements on huge pages.
 */

/** Stop scanning after this many elements (getComputedStyle per element adds up). */
export const PINNED_SCAN_LIMIT = 5000;

export function isPinnedPosition(position: string): boolean {
  return position === "fixed" || position === "sticky" || position === "-webkit-sticky";
}

export interface PinnedScan<T> {
  elements: T[];
  /** How many candidates were looked at. */
  scanned: number;
  /** True if the scan hit the limit before running out of candidates. */
  truncated: boolean;
}

/** Pick the pinned elements out of `candidates`, looking at no more than `limit`. */
export function findPinned<T>(
  candidates: Iterable<T>,
  positionOf: (element: T) => string,
  limit = PINNED_SCAN_LIMIT,
): PinnedScan<T> {
  const elements: T[] = [];
  let scanned = 0;
  for (const candidate of candidates) {
    if (scanned >= limit) return { elements, scanned, truncated: true };
    scanned++;
    if (isPinnedPosition(positionOf(candidate))) elements.push(candidate);
  }
  return { elements, scanned, truncated: false };
}

/** The bits of CSSStyleDeclaration we use (lets tests pass a fake). */
export interface InlineStyle {
  getPropertyValue(property: string): string;
  getPropertyPriority(property: string): string;
  setProperty(property: string, value: string, priority?: string): void;
  removeProperty(property: string): string;
}

/** Hide via inline `visibility: hidden !important`; returns a function that undoes exactly that. */
export function hideInline(style: InlineStyle): () => void {
  const previousValue = style.getPropertyValue("visibility");
  const previousPriority = style.getPropertyPriority("visibility");
  style.setProperty("visibility", "hidden", "important");
  return () => {
    if (previousValue) style.setProperty("visibility", previousValue, previousPriority);
    else style.removeProperty("visibility");
  };
}
