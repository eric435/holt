import { describe, expect, it } from "vitest";
import { findPinned, hideInline, isPinnedPosition, type InlineStyle } from "./pinned.js";

describe("isPinnedPosition", () => {
  it.each(["fixed", "sticky", "-webkit-sticky"])("%s is pinned", (p) => expect(isPinnedPosition(p)).toBe(true));
  it.each(["static", "relative", "absolute", ""])("%j is not", (p) => expect(isPinnedPosition(p)).toBe(false));
});

describe("findPinned", () => {
  const els = [
    { id: "header", position: "fixed" },
    { id: "main", position: "static" },
    { id: "th", position: "sticky" },
    { id: "modal", position: "absolute" },
    { id: "chat", position: "fixed" },
  ];

  it("selects fixed and sticky elements", () => {
    const scan = findPinned(els, (e) => e.position);
    expect(scan.elements.map((e) => e.id)).toEqual(["header", "th", "chat"]);
    expect(scan).toMatchObject({ scanned: 5, truncated: false });
  });

  it("stops at the limit and says so", () => {
    const scan = findPinned(els, (e) => e.position, 3);
    expect(scan.elements.map((e) => e.id)).toEqual(["header", "th"]);
    expect(scan).toMatchObject({ scanned: 3, truncated: true });
  });

  it("is not truncated when the candidates end exactly at the limit", () => {
    expect(findPinned(els, (e) => e.position, 5).truncated).toBe(false);
  });

  it("works with lazy iterables and looks at no more than the limit", () => {
    let pulled = 0;
    function* many() {
      for (let i = 0; i < 1e6; i++) {
        pulled++;
        yield { position: i % 1000 === 0 ? "fixed" : "static" };
      }
    }
    const scan = findPinned(many(), (e) => e.position, 2500);
    expect(scan.elements).toHaveLength(3);
    expect(pulled).toBeLessThanOrEqual(2501);
  });
});

/** A fake inline style with the same semantics as CSSStyleDeclaration for one property. */
function fakeStyle(initial?: { value: string; priority: string }): InlineStyle & { state: () => { value: string; priority: string } } {
  let value = initial?.value ?? "";
  let priority = initial?.priority ?? "";
  return {
    getPropertyValue: () => value,
    getPropertyPriority: () => priority,
    setProperty: (_p, v, prio = "") => {
      value = v;
      priority = prio;
    },
    removeProperty: () => {
      const old = value;
      value = "";
      priority = "";
      return old;
    },
    state: () => ({ value, priority }),
  };
}

describe("hideInline", () => {
  it("hides with !important and restores to no inline value", () => {
    const style = fakeStyle();
    const restore = hideInline(style);
    expect(style.state()).toEqual({ value: "hidden", priority: "important" });
    restore();
    expect(style.state()).toEqual({ value: "", priority: "" });
  });

  it("restores a previous inline value and priority exactly", () => {
    const style = fakeStyle({ value: "visible", priority: "important" });
    const restore = hideInline(style);
    expect(style.state().value).toBe("hidden");
    restore();
    expect(style.state()).toEqual({ value: "visible", priority: "important" });
  });

  it("restores a previous non-important value", () => {
    const style = fakeStyle({ value: "collapse", priority: "" });
    hideInline(style)();
    expect(style.state()).toEqual({ value: "collapse", priority: "" });
  });
});
