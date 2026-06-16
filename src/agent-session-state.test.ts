/**
 * AgentSessionState tests — the per-channel `claude -p` session-id store that
 * powers `--resume` continuity.
 *
 * Covered:
 *  - get() returns undefined for an unknown channel (→ first turn omits --resume);
 *  - set() persists + last-write-wins; a blank id is a no-op; reports whether it changed;
 *  - per-channel independence;
 *  - persist + reload across a simulated restart (a new instance reads the file);
 *  - clear() drops a channel's id (next turn starts fresh);
 *  - a corrupt file is tolerated (starts empty).
 *
 * Each test points the store at a throwaway temp dir — no shared global state, no
 * touch of the real `~/.parachute/channel/`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentSessionState } from "./agent-session-state.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-agent-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("get / set", () => {
  test("an unknown channel returns undefined (so the first turn omits --resume)", () => {
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.get("never-seen")).toBeUndefined();
  });

  test("set stores the id; get returns it; the change is reported", () => {
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.set("eng", "sess-abc")).toBe(true);
    expect(s.get("eng")).toBe("sess-abc");
  });

  test("set is last-write-wins; re-setting the SAME id is a no-op reporting false", () => {
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.set("eng", "sess-1")).toBe(true);
    expect(s.set("eng", "sess-1")).toBe(false); // unchanged
    expect(s.set("eng", "sess-2")).toBe(true); // a fresh id overwrites
    expect(s.get("eng")).toBe("sess-2");
  });

  test("a blank/empty id is a no-op (never store a blank — would `--resume \"\"`)", () => {
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.set("eng", "")).toBe(false);
    expect(s.get("eng")).toBeUndefined();
  });

  test("per-channel ids are independent", () => {
    const s = new AgentSessionState({ stateDir: dir });
    s.set("a", "sess-a");
    s.set("b", "sess-b");
    expect(s.get("a")).toBe("sess-a");
    expect(s.get("b")).toBe("sess-b");
  });
});

describe("clear", () => {
  test("drops a channel's id so the next turn starts fresh; reports whether one existed", () => {
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.clear("eng")).toBe(false); // nothing to clear
    s.set("eng", "sess-x");
    expect(s.clear("eng")).toBe(true);
    expect(s.get("eng")).toBeUndefined();
  });
});

describe("persist + reload (simulated restart)", () => {
  test("a fresh instance reads the persisted ids", () => {
    const s1 = new AgentSessionState({ stateDir: dir });
    s1.set("eng", "sess-eng");
    s1.set("ops", "sess-ops");
    expect(existsSync(join(dir, "agent-session-state.json"))).toBe(true);

    const s2 = new AgentSessionState({ stateDir: dir });
    expect(s2.get("eng")).toBe("sess-eng");
    expect(s2.get("ops")).toBe("sess-ops");
    expect(s2.get("brand-new")).toBeUndefined();
  });

  test("the persisted file is valid JSON of channel→id, written 0600", () => {
    const s = new AgentSessionState({ stateDir: dir });
    s.set("eng", "sess-eng");
    const path = join(dir, "agent-session-state.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ eng: "sess-eng" });
    // A session id is a continuation handle — treat it as sensitive (0600).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("clear is persisted (a restart doesn't resurrect a cleared id)", () => {
    const s1 = new AgentSessionState({ stateDir: dir });
    s1.set("eng", "sess-eng");
    s1.clear("eng");
    const s2 = new AgentSessionState({ stateDir: dir });
    expect(s2.get("eng")).toBeUndefined();
  });

  test("a corrupt file is tolerated — starts empty, still usable", () => {
    writeFileSync(join(dir, "agent-session-state.json"), "{ not json");
    const s = new AgentSessionState({ stateDir: dir });
    expect(s.get("eng")).toBeUndefined();
    expect(s.set("eng", "sess-fresh")).toBe(true); // overwrites the corrupt file
    const s2 = new AgentSessionState({ stateDir: dir });
    expect(s2.get("eng")).toBe("sess-fresh");
  });
});
