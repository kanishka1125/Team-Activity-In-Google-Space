import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readUnallocatedConfig,
  type UnallocatedConfig,
} from "../src/config/runtimeConfig.js";
import { KekaClient, type KekaEmployee } from "../src/integrations/keka/keka.client.js";
import { PmsTasksClient } from "../src/integrations/pms/pms.client.js";
import type { PmsTask } from "../src/integrations/pms/pms.types.js";
import type { TeamActivityEvent } from "../src/services/teamActivity.service.js";
import { TeamActivityStateStore } from "../src/services/teamActivityState.store.js";
import {
  UNALLOCATED_HEADER,
  UnallocatedResourcesJob,
  buildUnallocatedMessage,
  computeUnallocated,
  leaveEmailsToday,
  parsePmsDueDate,
} from "../src/services/unallocated.service.js";

process.env.TIME_TRACKER_API_URL ||= "http://127.0.0.1:9/unused";
const { TeamActivityWatcherService } = await import(
  "../src/services/teamActivityWatcher.service.js"
);

const TODAY = "2026-09-29";

const emp = (name: string, email = `${name.toLowerCase().split(" ")[0]}@x.in`): KekaEmployee => ({
  id: name,
  name,
  email,
});

const task = (assignee: string, status: string, dueDate: string, subs: PmsTask["subs"] = []): PmsTask => ({
  id: Math.random().toString(36).slice(2),
  assignee,
  status,
  dueDate,
  subs,
});

const compute = (
  employees: KekaEmployee[],
  tasks: PmsTask[],
  extra: Partial<Parameters<typeof computeUnallocated>[0]> = {},
) =>
  computeUnallocated({
    employees,
    tasks,
    leaveEmails: new Set(),
    excludedEmails: new Set(),
    today: TODAY,
    ...extra,
  });

const names = (r: ReturnType<typeof computeUnallocated>) => r.unallocated.map((e) => e.name);

// ---------------------------------------------------------------
describe("PMS allocation rule", () => {
  it("7. open task due TODAY → allocated", () => {
    expect(names(compute([emp("Asha")], [task("asha@x.in", "In Progress", "2026-09-29")]))).toEqual([]);
  });

  it("8. open task due in the FUTURE → allocated", () => {
    expect(names(compute([emp("Asha")], [task("asha@x.in", "To Do", "2026-10-15")]))).toEqual([]);
  });

  it("   overdue open task (due before today) does NOT allocate", () => {
    expect(names(compute([emp("Asha")], [task("asha@x.in", "In Progress", "2026-09-28")]))).toEqual(["Asha"]);
  });

  it("9. only Done / Closed tasks → no qualifying task", () => {
    const r = compute([emp("Asha")], [task("asha@x.in", "Done", "2026-10-10"), task("asha@x.in", "Closed", "2026-10-10")]);
    expect(names(r)).toEqual(["Asha"]);
  });

  it("10. no task at all → candidate", () => {
    expect(names(compute([emp("Asha")], [task("other@x.in", "To Do", "2026-10-10")]))).toEqual(["Asha"]);
  });

  it("11. email matching ignores case and whitespace", () => {
    expect(names(compute([emp("Asha", "Asha@X.in ")], [task("  ASHA@x.IN", "To Do", "2026-10-10")]))).toEqual([]);
  });

  it("12. both PMS date formats are understood (and bad dates are not)", () => {
    expect(parsePmsDueDate("2026-09-29")).toBe("2026-09-29");
    expect(parsePmsDueDate("2026-09-29T18:30")).toBe("2026-09-29");
    expect(parsePmsDueDate("2026-09-29T00:00")).toBe("2026-09-29");
    expect(parsePmsDueDate("")).toBeNull();
    expect(parsePmsDueDate("29-09-2026")).toBeNull();
    expect(parsePmsDueDate("2026-02-30")).toBeNull();
    expect(parsePmsDueDate(undefined)).toBeNull();

    // a task due late today still counts; empty / invalid due date does not
    expect(names(compute([emp("A"), emp("B"), emp("C")], [
      task("a@x.in", "To Do", "2026-09-29T23:59"),
      task("b@x.in", "To Do", ""),
      task("c@x.in", "To Do", "soon"),
    ]))).toEqual(["B", "C"]);
  });

  it("an unrecognised PMS status is NOT assumed open (and is reported)", () => {
    const r = compute([emp("Asha")], [task("asha@x.in", "In Review", "2026-10-10")]);
    expect(names(r)).toEqual(["Asha"]);
    expect(r.unknownStatuses).toEqual(["In Review"]);
  });

  it("a subtask assigned to the person (open, due today or later) allocates them", () => {
    const r = compute([emp("Asha"), emp("Ben")], [
      task("ben@x.in", "To Do", "2026-10-10", [
        { assignee: "asha@x.in", status: "In Progress", dueDate: "2026-09-30" },
        { assignee: "ben@x.in", status: "Done", dueDate: "2026-09-30" },
      ]),
    ]);
    expect(names(r)).toEqual([]);
  });
});

describe("leave, exclusions and the directory", () => {
  it("14. on leave (no task) → excluded", () => {
    expect(names(compute([emp("Krishna")], [], { leaveEmails: new Set(["krishna@x.in"]) }))).toEqual([]);
  });

  it("   on leave WITH a task → excluded", () => {
    expect(names(compute([emp("Krishna")], [task("krishna@x.in", "To Do", "2026-10-10")], { leaveEmails: new Set(["krishna@x.in"]) }))).toEqual([]);
  });

  it("15. approved excluded leadership email → excluded", () => {
    const r = compute([emp("Founder", "founder@x.in"), emp("Asha")], [], { excludedEmails: new Set(["founder@x.in"]) });
    expect(names(r)).toEqual(["Asha"]);
    expect(r.counts.excluded).toBe(1);
  });

  it("16/17. regular employees and Project Managers stay included unless explicitly excluded; nobody is excluded by guess", () => {
    const r = compute([emp("Rahul"), emp("Pam Manager"), emp("Dir Ector")], [], { excludedEmails: new Set(["someone-else@x.in"]) });
    expect(names(r)).toEqual(["Dir Ector", "Pam Manager", "Rahul"]);
  });

  it("18. an employee with NO Time Tracker row is still evaluated (Keka is the directory)", () => {
    const r = compute([emp("Newbie")], [], { leaveEmails: new Set(["someone-else@x.in"]) });
    expect(names(r)).toEqual(["Newbie"]);
  });

  it("the spec example: Rahul, Shalini listed; Krishna (leave) and Ankur (task) not", () => {
    const r = compute(
      [emp("Rahul"), emp("Shalini"), emp("Krishna"), emp("Ankur")],
      [task("ankur@x.in", "In Progress", "2026-10-02")],
      { leaveEmails: new Set(["krishna@x.in"]) },
    );
    expect(buildUnallocatedMessage(r.unallocated)).toBe(`${UNALLOCATED_HEADER}\n\nRahul\nShalini`);
  });

  it("an explicit alias maps a Time Tracker address to the Keka one (marketing@ → krishna@)", () => {
    const r = compute([emp("Krishna Kumar", "krishna.kumar@x.in")], [], {
      leaveEmails: new Set(["marketing@x.in"]),
      emailAliases: { "marketing@x.in": "krishna.kumar@x.in" },
    });
    expect(names(r)).toEqual([]);

    const noAlias = compute([emp("Krishna Kumar", "krishna.kumar@x.in")], [], { leaveEmails: new Set(["marketing@x.in"]) });
    expect(names(noAlias)).toEqual(["Krishna Kumar"]);
  });

  it("only today's leave rows count", () => {
    const row = (email: string, date: string, type: TeamActivityEvent["type"] = "leave"): TeamActivityEvent => ({
      id: email + date, type, name: "n", email, project: "", previousProject: null, startTime: "", dateSubmitted: date, totalHours: 0, message: "m",
    });
    const set = leaveEmailsToday([row("A@x.in", "29-09-2026"), row("b@x.in", "28-09-2026"), row("c@x.in", "29-09-2026", "login")], TODAY);
    expect([...set]).toEqual(["a@x.in"]);
  });
});

describe("settings", () => {
  const full = {
    KEKA_BASE_URL: "https://k.example", KEKA_CLIENT_ID: "id", KEKA_CLIENT_SECRET: "s", KEKA_API_KEY: "k",
    PMS_TASKS_API_URL: "https://pms.example/x", PMS_API_KEY: "p",
  };

  it("is ON only when every Keka / PMS setting is present", () => {
    expect(readUnallocatedConfig(full).enabled).toBe(true);
    expect(readUnallocatedConfig({}).enabled).toBe(false);
    expect(readUnallocatedConfig({}).warnings).toEqual([]); // not set up at all: silent
    const partial = readUnallocatedConfig({ ...full, KEKA_API_KEY: "" });
    expect(partial.enabled).toBe(false);
    expect(partial.warnings.join(" ")).toContain("KEKA_API_KEY");
    expect(readUnallocatedConfig({ ...full, UNALLOCATED_ENABLED: "false" }).enabled).toBe(false);
  });

  it("parses hours, normalised excluded emails and aliases; reports bad entries", () => {
    const c = readUnallocatedConfig({
      ...full,
      UNALLOCATED_EXCLUDED_EMAILS: " A@X.in, b@x.in ; not-an-email,a@x.in",
      UNALLOCATED_EMAIL_ALIASES: "M@x.in=k@x.in,broken",
      UNALLOCATED_CHECK_HOUR: "11",
      UNALLOCATED_LATEST_HOUR: "99",
    });
    expect(c.checkHour).toBe(11);
    expect(c.latestHour).toBe(15);
    expect(c.excludedEmails).toEqual(["a@x.in", "b@x.in"]);
    expect(c.emailAliases).toEqual({ "m@x.in": "k@x.in" });
    expect(c.warnings.length).toBe(3);
    expect(readUnallocatedConfig(full).checkHour).toBe(12);
  });
});

// ---------------------------------------------------------------
describe("Keka client", () => {
  const SECRETS = { id: "CID-123456", secret: "SECRET-abcdef", key: "APIKEY-xyz789" };
  const env = {
    KEKA_BASE_URL: "https://k.example/", KEKA_CLIENT_ID: SECRETS.id,
    KEKA_CLIENT_SECRET: SECRETS.secret, KEKA_API_KEY: SECRETS.key,
  };

  const rec = (name: string, status = 0, email = `${name.toLowerCase()}@x.in`) => ({
    id: name, displayName: name, firstName: name, lastName: "", email, employmentStatus: status,
  });

  function fakeKeka(opts: { pages?: unknown[][]; extra?: Record<string, unknown>; tokenStatus?: number } = {}) {
    const calls: { url: string; auth?: string }[] = [];
    let tokenCalls = 0;
    const fetchFn = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (url.includes("/connect/token")) {
        tokenCalls++;
        if (opts.tokenStatus) return new Response("{}", { status: opts.tokenStatus });
        return Response.json({ access_token: "TOKEN-VALUE", expires_in: 86400, token_type: "Bearer" });
      }
      const page = Number(new URL(url).searchParams.get("pageNumber"));
      const pages = opts.pages ?? [[]];
      const total = pages.reduce((n, p) => n + p.length, 0);
      return Response.json({
        succeeded: true, data: pages[page - 1] ?? [], pageNumber: page, pageSize: 200,
        totalPages: pages.length, totalRecords: total, ...opts.extra,
      });
    }) as unknown as typeof fetch;
    return { fetchFn, calls, tokenCalls: () => tokenCalls };
  }

  const client = (f: ReturnType<typeof fakeKeka>, over: Record<string, unknown> = {}) =>
    new KekaClient({ env, fetchFn: f.fetchFn, sleep: async () => {}, ...over });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("1. current (Working) employees are returned with Keka names and normalised emails", async () => {
    const f = fakeKeka({ pages: [[rec("Asha"), { ...rec("Ben"), email: " BEN@X.in " }]] });
    const list = await client(f).getActiveEmployees();
    expect(list.map((e) => [e.name, e.email])).toEqual([["Asha", "asha@x.in"], ["Ben", "ben@x.in"]]);
    expect(f.calls.some((c) => c.url.includes("employmentStatus=Working"))).toBe(true);
    expect(f.calls.find((c) => c.url.includes("/api/v1/hris/employees"))!.auth).toBe("Bearer TOKEN-VALUE");
    expect(f.calls.find((c) => c.url.includes("/api/v1/hris/employees"))!.url.startsWith("https://k.example/api/")).toBe(true);
  });

  it("2. a Relieved employee in the response is refused (never listed)", async () => {
    const f = fakeKeka({ pages: [[rec("Asha"), rec("Gone", 1)]] });
    await expect(client(f).getActiveEmployees()).rejects.toThrow(/not in Working status/);
  });

  it("3/4. joiners appear and leavers disappear on the next refresh — no list in the code", async () => {
    let data = [rec("Asha"), rec("Ben")];
    const fetchFn = (async (input: string) => {
      if (String(input).includes("/connect/token")) return Response.json({ access_token: "t", expires_in: 86400 });
      return Response.json({ succeeded: true, data, totalPages: 1, totalRecords: data.length, pageNumber: 1, pageSize: 200 });
    }) as unknown as typeof fetch;
    const c = new KekaClient({ env, fetchFn, sleep: async () => {} });

    expect((await c.getActiveEmployees()).map((e) => e.name)).toEqual(["Asha", "Ben"]);
    data = [rec("Asha"), rec("Cara")]; // Ben relieved, Cara joined
    expect((await c.getActiveEmployees()).map((e) => e.name)).toEqual(["Asha", "Cara"]);
  });

  it("5. invalid or incomplete responses fail safely", async () => {
    await expect(client(fakeKeka({ pages: [[rec("Asha")]], extra: { succeeded: false } })).getActiveEmployees()).rejects.toThrow(/unexpected employee response/);
    await expect(client(fakeKeka({ pages: [[rec("Asha")]], extra: { totalRecords: 5 } })).getActiveEmployees()).rejects.toThrow(/incomplete \(1 received, 5 expected\)/);
    await expect(client(fakeKeka({ pages: [[rec("Asha")]], extra: { totalPages: "x", totalRecords: undefined } })).getActiveEmployees()).rejects.toThrow(/completeness cannot be checked/);
    await expect(client(fakeKeka({ pages: [[]] })).getActiveEmployees()).rejects.toThrow(/no working employees/);

    const html = (async (input: string) =>
      String(input).includes("/connect/token")
        ? Response.json({ access_token: "t", expires_in: 100 })
        : new Response("<!DOCTYPE html><html>error</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(new KekaClient({ env, fetchFn: html, sleep: async () => {} }).getActiveEmployees()).rejects.toThrow(/not JSON/);

    await expect(client(fakeKeka({ tokenStatus: 400 })).getActiveEmployees()).rejects.toThrow(/Keka sign-in failed: HTTP 400/);
  });

  it("reads every page and checks the total", async () => {
    const f = fakeKeka({ pages: [[rec("Asha"), rec("Ben")], [rec("Cara")]] });
    expect((await client(f).getActiveEmployees()).map((e) => e.name)).toEqual(["Asha", "Ben", "Cara"]);
    // page 2 missing → incomplete, never a partial list
    const broken = (async (input: string) => {
      if (String(input).includes("/connect/token")) return Response.json({ access_token: "t", expires_in: 100 });
      const p = Number(new URL(String(input)).searchParams.get("pageNumber"));
      return Response.json({ succeeded: true, data: p === 1 ? [rec("Asha")] : [], totalPages: 2, totalRecords: 2, pageNumber: p, pageSize: 200 });
    }) as unknown as typeof fetch;
    await expect(new KekaClient({ env, fetchFn: broken, sleep: async () => {} }).getActiveEmployees()).rejects.toThrow(/incomplete/);
  });

  it("retries a timeout / server error a few times, then succeeds", async () => {
    let n = 0;
    const flaky = (async (input: string) => {
      if (String(input).includes("/connect/token")) return Response.json({ access_token: "t", expires_in: 100 });
      n++;
      if (n === 1) throw Object.assign(new Error("x"), { name: "TimeoutError" });
      if (n === 2) return new Response("", { status: 503 });
      return Response.json({ succeeded: true, data: [rec("Asha")], totalPages: 1, totalRecords: 1, pageNumber: 1, pageSize: 200 });
    }) as unknown as typeof fetch;
    expect((await new KekaClient({ env, fetchFn: flaky, sleep: async () => {} }).getActiveEmployees()).length).toBe(1);
    expect(n).toBe(3);
  });

  it("re-signs in once if the token is rejected (401)", async () => {
    let tokens = 0;
    let first = true;
    const f = (async (input: string) => {
      if (String(input).includes("/connect/token")) { tokens++; return Response.json({ access_token: `t${tokens}`, expires_in: 86400 }); }
      if (first) { first = false; return new Response("", { status: 401 }); }
      return Response.json({ succeeded: true, data: [rec("Asha")], totalPages: 1, totalRecords: 1, pageNumber: 1, pageSize: 200 });
    }) as unknown as typeof fetch;
    expect((await new KekaClient({ env, fetchFn: f, sleep: async () => {} }).getActiveEmployees()).length).toBe(1);
    expect(tokens).toBe(2);
  });

  it("6. credentials never appear in logs or error messages", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));

    const errors: string[] = [];
    for (const f of [fakeKeka({ tokenStatus: 400 }), fakeKeka({ pages: [[rec("A", 1)]] }), fakeKeka({ pages: [[rec("A")]], extra: { totalRecords: 9 } })]) {
      try { await client(f).getActiveEmployees(); } catch (e) { errors.push((e as Error).message); }
    }
    const refused = (async () => { throw new Error(`connect failed ${SECRETS.key} ${SECRETS.secret}`); }) as unknown as typeof fetch;
    try { await new KekaClient({ env, fetchFn: refused, sleep: async () => {} }).getActiveEmployees(); } catch (e) { errors.push((e as Error).message); }

    const everything = [...out, ...errors].join("\n");
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("TOKEN-VALUE");
    expect(errors.length).toBe(4);
  });
});

// ---------------------------------------------------------------
describe("PMS tasks client", () => {
  const env = { PMS_TASKS_API_URL: "https://pms.example/exec", PMS_API_KEY: "PMS-SECRET-KEY" };
  const ok = (tasks: unknown[] = [task("a@x.in", "To Do", "2026-10-10")]) => Response.json({ ok: true, tasks });
  const make = (fetchFn: unknown) => new PmsTasksClient({ env, fetchFn: fetchFn as typeof fetch, sleep: async () => {} });

  it("returns the tasks and calls the same API as AIOS (api=1&action=tasks&key=…)", async () => {
    let url = "";
    const t = await make(async (u: string) => { url = u; return ok(); }).getTasks();
    expect(t.length).toBe(1);
    const q = new URL(url).searchParams;
    expect([q.get("api"), q.get("action"), q.get("key")]).toEqual(["1", "tasks", "PMS-SECRET-KEY"]);
  });

  it("13. a transient 404 HTML page, a timeout and non-JSON are retried, then it succeeds", async () => {
    let n = 0;
    const t = await make(async () => {
      n++;
      if (n === 1) return new Response("<!DOCTYPE html>not found", { status: 404 });
      if (n === 2) throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      if (n === 3) return new Response("<!DOCTYPE html>oops", { status: 200 });
      return ok();
    }).getTasks();
    expect(t.length).toBe(1);
    expect(n).toBe(4);
  });

  it("13. persistent failure throws — it is never an empty task list", async () => {
    let n = 0;
    await expect(make(async () => { n++; return new Response("<!DOCTYPE html>", { status: 404 }); }).getTasks()).rejects.toThrow(/gave up after 4 attempts/);
    expect(n).toBe(4);
    await expect(make(async () => Response.json({ ok: false })).getTasks()).rejects.toThrow();
    await expect(make(async () => Response.json({ ok: true, tasks: [] })).getTasks()).rejects.toThrow(/empty task list/);
    await expect(make(async () => Response.json({ ok: true })).getTasks()).rejects.toThrow(/no task list/);
  });

  it("the API key never appears in an error message", async () => {
    const e = await make(async () => { throw new Error(`boom PMS-SECRET-KEY`); }).getTasks().catch((x: Error) => x.message);
    expect(e).not.toContain("PMS-SECRET-KEY");
  });
});

// ---------------------------------------------------------------
// Daily 12 PM notification through the existing watcher / PENDING-SENT state
describe("daily 12 PM notification (existing PENDING/SENT lifecycle)", () => {
  // 2026-09-29 12:05 India time
  const NOON = new Date("2026-09-29T06:35:00Z");
  let dir: string;
  let clock: Date;
  let sent: string[];
  let chatDown: boolean;
  let activities: TeamActivityEvent[];
  let employees: KekaEmployee[];
  let tasks: PmsTask[];
  let kekaDown: boolean;
  let kekaCalls: number;

  const leaveRow = (name: string, email: string): TeamActivityEvent => ({
    id: `leave-${email}-${TODAY}`, type: "leave", name, email, project: "", previousProject: null,
    startTime: "", dateSubmitted: "29-09-2026", totalHours: 0, message: `${name} is on leave today`,
  });

  const config = (over: Partial<UnallocatedConfig> = {}): UnallocatedConfig => ({
    enabled: true, reason: null, checkHour: 12, latestHour: 15, excludedEmails: [], emailAliases: {}, warnings: [], ...over,
  });

  const job = (over: Partial<UnallocatedConfig> = {}) =>
    new UnallocatedResourcesJob({
      config: config(over),
      employees: { getActiveEmployees: async () => { kekaCalls++; if (kekaDown) throw new Error("Keka did not respond"); return employees; } },
      tasks: { getTasks: async () => tasks },
    });

  const watcher = (unallocated: UnallocatedResourcesJob | null = job()) =>
    new TeamActivityWatcherService({
      store: new TeamActivityStateStore(dir),
      activitySource: { getActivity: async () => [...activities] },
      chat: { sendTeamActivityMessage: async (m: string) => { if (chatDown) throw new Error("Google Chat webhook failed: 500"); sent.push(m); } },
      now: () => clock,
      sleep: async () => {},
      legacyLeaveStateFile: path.join(dir, "none.json"),
      unallocated,
    });

  const record = () =>
    new TeamActivityStateStore(dir).load(TODAY).state.records.find((r) => r.activityId === `unallocated-${TODAY}`);

  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unalloc-"));
    clock = NOON;
    sent = [];
    chatDown = false;
    kekaDown = false;
    kekaCalls = 0;
    activities = [];
    employees = [emp("Rahul"), emp("Shalini"), emp("Krishna"), emp("Ankur")];
    tasks = [task("ankur@x.in", "In Progress", "2026-10-02")];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("19. sends ONE message listing every eligible employee (spec example)", async () => {
    activities = [leaveRow("Krishna", "krishna@x.in")];
    const w = watcher();
    await w.check(); // first run: records activity, then 12 PM job
    expect(sent.filter((m) => m.startsWith("🟡"))).toEqual([`${UNALLOCATED_HEADER}\n\nRahul\nShalini`]);
    expect(record()!.status).toBe("sent");
    expect(record()!.type).toBe("unallocated");
  });

  it("20. nobody unallocated → no message and no empty report", async () => {
    tasks = employees.map((e) => task(e.email, "To Do", "2026-10-30"));
    await watcher().check();
    expect(sent).toEqual([]);
    expect(record()).toBeUndefined();
  });

  it("does nothing before 12:00 and starts at 12:00 India time", async () => {
    clock = new Date("2026-09-29T06:29:00Z"); // 11:59
    const w = watcher();
    await w.check();
    expect(kekaCalls).toBe(0);
    expect(sent).toEqual([]);
    clock = new Date("2026-09-29T06:30:00Z"); // 12:00
    await w.check();
    expect(sent.length).toBe(1);
  });

  it("21/10. sent at most once per day — re-running the check never duplicates it", async () => {
    const w = watcher();
    await w.check();
    await w.check();
    await w.check();
    expect(sent.length).toBe(1);
    expect(kekaCalls).toBe(1);
  });

  it("22. restart after a successful send → not sent again, and Keka is not even asked", async () => {
    await watcher().check();
    expect(sent.length).toBe(1);
    kekaCalls = 0;
    await watcher().check();
    await watcher().check();
    expect(sent.length).toBe(1);
    expect(kekaCalls).toBe(0);
  });

  it("23. failed delivery → stays PENDING and the existing retry sends it later (once)", async () => {
    chatDown = true;
    const w = watcher();
    await w.check();
    expect(sent).toEqual([]);
    expect(record()!.status).toBe("pending");

    chatDown = false;
    advance(60_000);
    await w.check();
    expect(sent.length).toBe(1);
    expect(record()!.status).toBe("sent");

    advance(60_000);
    await w.check();
    await watcher().check();
    expect(sent.length).toBe(1);
  });

  it("a PENDING report survives a restart and is delivered by the new process", async () => {
    chatDown = true;
    await watcher().check();
    expect(record()!.status).toBe("pending");
    chatDown = false;
    advance(60_000);
    await watcher().check();
    expect(sent.length).toBe(1);
  });

  it("Keka unreachable → NOTHING is sent (no guessing), retried after 5 minutes", async () => {
    kekaDown = true;
    const w = watcher();
    await w.check();
    expect(sent).toEqual([]);
    expect(record()).toBeUndefined();

    kekaDown = false;
    advance(60_000); // too early
    await w.check();
    expect(sent).toEqual([]);

    advance(5 * 60_000);
    await w.check();
    expect(sent.length).toBe(1);
  });

  it("past the cut-off hour a restart does not post a stale 12 PM report", async () => {
    clock = new Date("2026-09-29T10:45:00Z"); // 16:15 India time
    await watcher().check();
    expect(sent).toEqual([]);
    expect(kekaCalls).toBe(0);
  });

  it("report is off (nothing happens) when the feature is not configured", async () => {
    await watcher(null).check();
    expect(sent).toEqual([]);
    expect(kekaCalls).toBe(0);
  });

  it("approved exclusions are applied from configuration", async () => {
    employees = [emp("Founder", "founder@x.in"), emp("Asha")];
    tasks = [];
    await watcher(job({ excludedEmails: ["founder@x.in"] })).check();
    expect(sent).toEqual([`${UNALLOCATED_HEADER}\n\nAsha`]);
  });

  it("the message is a normal Team Activity record: the state file lists it with a readable label", async () => {
    await watcher().check();
    const csv = fs.readFileSync(path.join(dir, "sent-entries.csv"), "utf-8");
    expect(csv).toContain("Unallocated resources");
  });
});

// ---------------------------------------------------------------
describe("regression: normal activity and leave notifications are unchanged by the new job", () => {
  let dir: string;
  const sent: string[] = [];
  const DAY = new Date("2026-09-29T08:30:00Z"); // 14:00 India time

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unalloc-reg-"));
    sent.length = 0;
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("30/31/32. a new work activity and a new leave each post once, with the same message text, even with the job on", async () => {
    let rows: TeamActivityEvent[] = [];
    const work: TeamActivityEvent = {
      id: `activity-asha@x.in-${TODAY}-9:30-eureka`, type: "login", name: "Asha", email: "asha@x.in", project: "Eureka", previousProject: null,
      startTime: "9:30", dateSubmitted: "29-09-2026", totalHours: 0, message: "Asha has started working on Eureka at 9:30 AM",
    };
    const lv: TeamActivityEvent = {
      id: `leave-lina@x.in-${TODAY}`, type: "leave", name: "Lina", email: "lina@x.in", project: "", previousProject: null,
      startTime: "", dateSubmitted: "29-09-2026", totalHours: 0, message: "Lina is on leave today",
    };
    const idle = new UnallocatedResourcesJob({
      config: { enabled: true, reason: null, checkHour: 12, latestHour: 15, excludedEmails: [], emailAliases: {}, warnings: [] },
      employees: { getActiveEmployees: async () => [emp("Zed")] },
      tasks: { getTasks: async () => [task("zed@x.in", "To Do", "2026-12-01")] },
    });
    const w = () =>
      new TeamActivityWatcherService({
        store: new TeamActivityStateStore(dir),
        activitySource: { getActivity: async () => [...rows] },
        chat: { sendTeamActivityMessage: async (m: string) => void sent.push(m) },
        now: () => DAY, sleep: async () => {}, legacyLeaveStateFile: path.join(dir, "none.json"), unallocated: idle,
      });

    const first = w();
    await first.check(); // baseline
    rows = [work];
    await first.check();
    rows = [work, lv];
    await first.check();
    await first.check();
    await w().check(); // restart

    expect(sent).toEqual(["🟢 Asha has started working on Eureka at 9:30 AM", "🔴 Lina is on leave today"]);
  });
});
