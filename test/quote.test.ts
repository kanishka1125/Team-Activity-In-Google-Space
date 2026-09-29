import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuoteService } from "../src/services/quote.service.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quotes-"));
  file = path.join(dir, ".good-morning-quote-state.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 10:00 IST on the given date
const day = (iso: string) => new Date(`${iso}T04:30:00Z`);
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function service(date: string, opts: { ai?: (p: string) => Promise<string> } = {}) {
  return new QuoteService({
    stateFile: file,
    now: () => day(date),
    aiEnabled: () => !!opts.ai,
    generate: opts.ai ?? (async () => ""),
  });
}

const json = (q: string) => JSON.stringify({ quote: q });

// The two real quotes from 24 and 29 Sep that looked like repeats.
const REAL_24 =
  "Consistent effort, clear ownership, and open collaboration turn small improvements into reliable excellence—lead by doing, learn quickly, and support the team’s progress.";
const REAL_29 =
  "Consistent effort, clear ownership, and open collaboration turn small improvements into lasting excellence—lead by discipline and learn from every step forward.";

describe("Good Morning quotes never repeat", () => {
  it("catches the real near-duplicate from 24 and 29 Sep", () => {
    expect(service("2026-09-30").isTooSimilar(REAL_24, REAL_29)).toBe(true);
  });

  it("does not flag genuinely different quotes", () => {
    const s = service("2026-09-30");
    expect(
      s.isTooSimilar(
        "The quality of our work is shaped by the consistency we bring to it every day.",
        "Great work begins with ownership, grows through collaboration, and improves through consistency.",
      ),
    ).toBe(false);
  });

  it("all 50 built-in quotes are distinct from each other", () => {
    const s = service("2026-09-30");
    const quotes = (s as unknown as { fallbackQuotes: { quote: string }[] }).fallbackQuotes.map((q) => q.quote);
    expect(quotes).toHaveLength(50);
    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        expect(s.isTooSimilar(quotes[i]!, quotes[j]!), `${quotes[i]} ~ ${quotes[j]}`).toBe(false);
      }
    }
  });

  it("without AI: 50 weekdays with no repeat, then rotates oldest-first (never yesterday's)", async () => {
    const seen: string[] = [];
    let date = "2026-10-01";
    for (let i = 0; i < 60; i++) {
      seen.push((await service(date).getDailyQuote()).quote);
      date = addDays(date, 1);
    }
    expect(new Set(seen.slice(0, 50)).size).toBe(50);
    expect(seen[50]).toBe(seen[0]); // oldest comes back first, after all 50
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("same day → same quote (Good Morning retries reuse it)", async () => {
    const a = await service("2026-10-01").getDailyQuote();
    const b = await service("2026-10-01").getDailyQuote();
    expect(b.quote).toBe(a.quote);
  });

  it("AI near-copy is rejected and the AI is asked again; the prompt lists earlier quotes and a theme", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ dailyQuotes: { "2026-09-24": { quote: REAL_24 } }, usedQuotes: [REAL_24.toLowerCase()] }),
    );
    const prompts: string[] = [];
    const answers = [
      json(REAL_29), // near-copy → rejected
      json("Clear goals and honest updates help every team member spend their effort where it creates real value."),
    ];
    const q = await service("2026-09-29", {
      ai: async (p) => {
        prompts.push(p);
        return answers.shift()!;
      },
    }).getDailyQuote();

    expect(q.quote).toMatch(/^Clear goals and honest updates/);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(REAL_24);
    expect(prompts[0]).toMatch(/Today's theme: /);
    expect(prompts[0]).toContain("Suitable for a workplace."); // original rules kept
  });

  it("AI keeps returning near-copies → built-in quote instead, still no repeat", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ dailyQuotes: { "2026-09-24": { quote: REAL_24 } }, usedQuotes: [REAL_24.toLowerCase()] }),
    );
    const s = service("2026-09-29", { ai: async () => json(REAL_29) });
    const q = await s.getDailyQuote();
    expect(q.quote).not.toBe(REAL_29);
    expect(s.isTooSimilar(q.quote, REAL_24)).toBe(false);
  });

  it("AI down → built-in quote, and 30 AI days + fallbacks never repeat", async () => {
    let n = 0;
    const seen: string[] = [];
    let date = "2026-10-01";
    for (let i = 0; i < 40; i++) {
      const aiUp = i % 4 !== 3; // every 4th day the AI fails
      const q = await service(date, {
        ai: async () => {
          if (!aiUp) throw new Error("AI unavailable");
          n++;
          return json(`Unique idea number ${n} helps teams ${["plan", "build", "share", "review", "improve"][n % 5]} work in ${["new", "better", "clearer", "calmer"][n % 4]} ways ${"x".repeat(n % 7)} ${n * 7919}.`);
        },
      }).getDailyQuote();
      seen.push(q.quote);
      date = addDays(date, 1);
    }
    expect(new Set(seen).size).toBe(40);
  });

  it("works with the current real history file (next day is not a repeat)", async () => {
    const real = "/mnt/user-data/uploads/AI-organistaion-with-Team-Activity - Copy/google-space-team-activity/.good-morning-quote-state.json";
    if (!fs.existsSync(real)) return;
    fs.copyFileSync(real, file);
    const history = Object.values(
      (JSON.parse(fs.readFileSync(file, "utf-8")) as { dailyQuotes: Record<string, { quote: string }> }).dailyQuotes,
    ).map((q) => q.quote);
    const s = service("2026-09-30");
    const q = await s.getDailyQuote();
    expect(history.some((h) => s.isTooSimilar(h, q.quote))).toBe(false);
  });
});
