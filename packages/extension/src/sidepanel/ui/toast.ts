/**
 * Toasts: short messages at the bottom of the panel. Errors stay until
 * dismissed; info/success fade after a few seconds. A toast can carry one
 * action button (e.g. "Grant microphone access").
 */

import type { ToastLevel } from "../../shared/messages.js";
import { h } from "./dom.js";

let container: HTMLElement | null = null;

export function mountToasts(root: HTMLElement): void {
  container = root;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export function toast(level: ToastLevel, message: string, action?: ToastAction): void {
  if (!container) return;
  const close = (): void => node.remove();
  const node = h(
    "div",
    { class: `toast toast-${level}`, role: level === "error" ? "alert" : "status" },
    h("span", { class: "toast-text" }, message),
    action &&
      h("button", { class: "link", onclick: () => { action.run(); close(); } }, action.label),
    h("button", { class: "toast-close", "aria-label": "Dismiss", onclick: close }, "×"),
  );
  container.append(node);
  if (level !== "error") setTimeout(close, 4_000);
}
