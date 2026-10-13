/**
 * Area-select overlay (dist/content/area-select.js).
 *
 * Injected on demand into the active tab. Shows a full-viewport overlay with
 * a crosshair, lets the user drag a rectangle, then removes itself and sends
 * the rectangle (CSS px, relative to the viewport) to the worker:
 *
 *   { type: "area-selected", rect, viewport, devicePixelRatio }
 *   { type: "area-cancelled" }                       (Esc, or tab hidden)
 *
 * The overlay lives in a closed shadow root so the page's CSS cannot style
 * it and our CSS cannot leak into the page. The host element uses a custom
 * tag name so generic page selectors like `div { ... }` don't match it.
 *
 * Idempotent: injecting it again while an overlay is up does nothing.
 * Built as an IIFE because executeScript({ files }) runs classic scripts.
 */

import type { AreaCancelledMessage, AreaSelectedMessage, CssRect } from "../shared/messages.js";

declare global {
  interface Window {
    __nitpickAreaSelect?: true;
  }
}

/** Smaller drags are treated as accidental clicks. */
const MIN_SIZE_PX = 4;

const STYLE = `
  .layer {
    position: fixed; inset: 0; cursor: crosshair;
    background: rgba(15, 23, 42, 0.25);
    user-select: none; -webkit-user-select: none; touch-action: none;
  }
  .layer.dragging { background: transparent; }
  .box {
    position: fixed; border: 1px solid #fff; outline: 1px dashed #4c6ef5;
    /* A huge shadow dims everything outside the selection. */
    box-shadow: 0 0 0 100vmax rgba(15, 23, 42, 0.35);
    pointer-events: none;
  }
  .hint {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    font: 13px/1.4 system-ui, sans-serif; color: #fff; background: rgba(15, 23, 42, 0.85);
    padding: 6px 12px; border-radius: 6px; pointer-events: none; white-space: nowrap;
  }
  .size {
    position: fixed; font: 11px/1 ui-monospace, monospace; color: #fff;
    background: rgba(15, 23, 42, 0.85); padding: 3px 5px; border-radius: 3px; pointer-events: none;
  }
`;

if (!window.__nitpickAreaSelect) {
  window.__nitpickAreaSelect = true;
  showOverlay();
}

function showOverlay(): void {
  const host = document.createElement("nitpick-area-select");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  const layer = el("div", "layer");
  const hint = el("div", "hint");
  hint.textContent = "Drag to capture an area · Esc to cancel";
  const box = el("div", "box");
  const size = el("div", "size");
  box.hidden = true;
  size.hidden = true;
  layer.append(hint, box, size);
  shadow.append(style, layer);
  document.documentElement.append(host);

  let start: { x: number; y: number } | null = null;
  let rect: CssRect | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    rect = null;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!start) return;
    rect = normalize(start.x, start.y, e.clientX, e.clientY);
    layer.classList.add("dragging");
    hint.hidden = true;
    Object.assign(box.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    box.hidden = false;
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    Object.assign(size.style, { left: `${rect.x}px`, top: `${Math.max(0, rect.y - 20)}px` });
    size.hidden = false;
  };

  const onPointerUp = (): void => {
    const selected = rect;
    start = null;
    rect = null;
    if (!selected || selected.width < MIN_SIZE_PX || selected.height < MIN_SIZE_PX) {
      // Treat as a stray click: reset and keep waiting for a real drag.
      layer.classList.remove("dragging");
      box.hidden = size.hidden = true;
      hint.hidden = false;
      return;
    }
    void finish(selected);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation(); // don't let the page react to this Esc
    cancel();
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") cancel();
  };

  const preventScroll = (e: Event): void => e.preventDefault();

  layer.addEventListener("pointerdown", onPointerDown);
  layer.addEventListener("pointermove", onPointerMove);
  layer.addEventListener("pointerup", onPointerUp);
  layer.addEventListener("wheel", preventScroll, { passive: false });
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("visibilitychange", onVisibilityChange);

  function teardown(): void {
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    host.remove();
    delete window.__nitpickAreaSelect;
  }

  function cancel(): void {
    teardown();
    send({ type: "area-cancelled" });
  }

  async function finish(selected: CssRect): Promise<void> {
    teardown();
    // Let the page repaint without the overlay before the worker captures,
    // otherwise the dimming would end up in the screenshot.
    await nextFrame();
    await nextFrame();
    await new Promise((resolve) => setTimeout(resolve, 30));
    send({
      type: "area-selected",
      rect: selected,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }
}

function send(message: AreaSelectedMessage | AreaCancelledMessage): void {
  // Fails if the extension was reloaded since injection; nothing useful to do then.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function normalize(x0: number, y0: number, x1: number, y1: number): CssRect {
  const w = Math.max(0, window.innerWidth);
  const h = Math.max(0, window.innerHeight);
  const left = Math.max(0, Math.min(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const right = Math.min(w, Math.max(x0, x1));
  const bottom = Math.min(h, Math.max(y0, y1));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
