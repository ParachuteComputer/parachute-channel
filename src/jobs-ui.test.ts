/**
 * Tests for the Schedules page (src/jobs-ui.ts) — the runner's operator surface.
 * The page is a self-contained HTML+JS string (same shape as agents-ui.ts), so
 * these string-pin the served document: the create form, the list, the row
 * actions, the cron presets, the API wiring, the vault-only picker, the shared
 * shell, and the no-backtick-in-script-body invariant (so it can't break a host
 * template literal if ever embedded).
 */
import { describe, test, expect } from "bun:test";
import { JOBS_UI_HTML } from "./jobs-ui.ts";

const html = JOBS_UI_HTML;

describe("Schedules page — create form", () => {
  test("has the agent picker, id, message, cron, and tz inputs", () => {
    expect(html).toContain('id="f-channel"');
    expect(html).toContain('id="f-id"');
    expect(html).toContain('id="f-message"');
    expect(html).toContain('id="f-cron"');
    expect(html).toContain('id="f-tz"');
    expect(html).toContain('id="create-btn"');
  });

  test("offers cron presets (daily 8am, hourly, …)", () => {
    expect(html).toContain("daily 8am");
    expect(html).toContain("hourly");
    expect(html).toContain("weekdays 9am");
    expect(html).toContain('id="cron-presets"');
  });
});

describe("Schedules page — list + row actions", () => {
  test("renders a jobs table container + per-row enable/run/delete", () => {
    expect(html).toContain('id="jobs-table"');
    expect(html).toContain("data-toggle");
    expect(html).toContain("data-run");
    expect(html).toContain("data-del");
    expect(html).toContain("run now");
    expect(html).toContain("delete");
  });

  test("shows the at-a-glance columns: agent, cron, next run, last status", () => {
    expect(html).toContain("next run");
    expect(html).toContain("last status");
  });
});

describe("Schedules page — API wiring", () => {
  test("targets the /api/jobs routes", () => {
    expect(html).toContain('"/api/jobs"');
    expect(html).toContain('"/api/jobs/" + encodeURIComponent(id) + "/run"');
    expect(html).toContain('"/api/jobs/" + encodeURIComponent(id)');
  });

  test("filters the picker to VAULT channels only (jobs need a vault transport)", () => {
    expect(html).toContain('c.transport === "vault"');
    expect(html).toContain("/.parachute/config");
  });

  test("bootstraps the hub-minted token via the shared shell (fetchToken)", () => {
    expect(html).toContain("fetchToken()");
    expect(html).toContain('wireShell("schedules")');
  });
});

describe("Schedules page — invariants", () => {
  test("reuses the shared ui-kit shell (THEME_CSS + appShell nav)", () => {
    // The shared nav marks the schedules tab active.
    expect(html).toContain('data-view="schedules"');
    expect(html).toContain("app-header");
  });

  test("the inline <script> body contains NO literal backtick (host-literal safe)", () => {
    // Extract the <script>…</script> block and assert it's backtick-free, so the
    // page can never break a surrounding template literal. (Backticks in the file
    // are confined to the JSDoc + the two outer template delimiters.)
    const start = html.indexOf("<script>");
    const end = html.indexOf("</script>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const scriptBody = html.slice(start, end);
    expect(scriptBody.includes("`")).toBe(false); // U+0060 = backtick
  });
});
