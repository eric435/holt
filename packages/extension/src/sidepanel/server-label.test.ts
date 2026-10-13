import { describe, expect, it } from "vitest";
import { displayHost, projectName, serverLabel } from "./server-label.js";

describe("serverLabel", () => {
  it("puts the project first and drops http://", () => {
    expect(serverLabel({ version: "0.1.0", project: { name: "holt-monorepo", source: "package.json" } }, "http://127.0.0.1:4848")).toEqual({
      project: "holt-monorepo",
      detail: "holt 0.1.0 · 127.0.0.1:4848",
    });
  });
  it("tolerates an older server without `project`", () => {
    expect(serverLabel({ version: "0.1.0" }, "http://localhost:5173")).toEqual({ project: null, detail: "holt 0.1.0 · localhost:5173" });
  });
  it("tolerates junk", () => {
    expect(serverLabel({ version: 3, project: "acme" }, "http://localhost:1")).toEqual({ project: null, detail: "holt · localhost:1" });
  });
});

describe("projectName", () => {
  it("trims, rejects blanks and caps the length", () => {
    expect(projectName({ project: { name: "  acme-web " } })).toBe("acme-web");
    expect(projectName({ project: { name: "   " } })).toBeNull();
    expect(projectName({ project: { name: 42 } })).toBeNull();
    expect(projectName({ project: null })).toBeNull();
    expect(projectName({ project: { name: "x".repeat(300) } })).toHaveLength(100);
  });
});

describe("displayHost", () => {
  it("keeps https:// visible and strips a trailing slash", () => {
    expect(displayHost("https://localhost:8443/")).toBe("https://localhost:8443");
    expect(displayHost("HTTP://[::1]:4848")).toBe("[::1]:4848");
  });
});
