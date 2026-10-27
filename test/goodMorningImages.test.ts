// Good Morning picture rotation: a list of links, one used per weekday, an
// image is used up only after the message is really sent, and when all are
// used the round starts again. No network and no real Space is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleChatService } from "../src/integrations/googleChat/googleChat.service.js";
import {
  GoodMorningImagePicker,
  IMAGE_LIST_FILE,
  IMAGE_STATE_FILE,
  IMAGE_STATUS_FILE,
  parseImageList,
} from "../src/services/goodMorningImages.service.js";

const A = "https://site.example/img/a.png";
const B = "https://site.example/img/b.png";
const C = "https://site.example/img/c.png";
const OLD = "https://site.example/img/old-single.png";

// India wall-clock date → an instant (noon IST that day).
const day = (d: string) => new Date(`${d}T06:30:00Z`);

let dir = "";
let clock = { at: day("2026-10-14") };

const listFile = () => path.join(dir, IMAGE_LIST_FILE);
const writeList = (text: string) => fs.writeFileSync(listFile(), text);

function picker(overrides: { fallback?: string | undefined } = { fallback: OLD }) {
  return new GoodMorningImagePicker({
    listFile: listFile(),
    stateFile: path.join(dir, IMAGE_STATE_FILE),
    statusFile: path.join(dir, IMAGE_STATUS_FILE),
    now: () => clock.at,
    fallbackUrl: () => overrides.fallback,
  });
}

// One weekday's message: pick, "deliver", mark used. Returns the picture.
function sendDay(p: GoodMorningImagePicker, date: string) {
  clock = { at: day(date) };
  const choice = p.pick();
  p.markSent(choice);
  return choice.url;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-images-"));
  clock = { at: day("2026-10-14") };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the list file", () => {
  it("accepts https links, ignores blanks and # comments, drops duplicates", () => {
    const warnings: string[] = [];

    const links = parseImageList(
      `﻿# my pictures\n\n  ${A}  \r\n${B}\n${A}\n# ${C}\n`,
      warnings,
    );

    expect(links).toEqual([A, B]);
    expect(warnings).toEqual([]);
  });

  it("skips anything that is not an https link and says which line", () => {
    const warnings: string[] = [];

    expect(parseImageList(`${A}\nhttp://insecure.example/x.png\nnot a link\nftp://x/y\n${B}`, warnings)).toEqual([A, B]);
    expect(warnings.join(" ")).toMatch(/Line 2/);
    expect(warnings.join(" ")).toMatch(/Line 3/);
    expect(warnings.length).toBe(3);
  });
});

describe("daily rotation", () => {
  it("uses the pictures in file order, one per weekday", () => {
    writeList(`${A}\n${B}\n${C}\n`);
    const p = picker();

    expect(sendDay(p, "2026-10-14")).toBe(A);
    expect(sendDay(p, "2026-10-15")).toBe(B);
    expect(sendDay(p, "2026-10-16")).toBe(C);
  });

  it("when all are used, sent becomes the list again and the round starts over", () => {
    writeList(`${A}\n${B}\n${C}\n`);
    const p = picker();

    const used = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].map((d) => sendDay(p, d));

    expect(used).toEqual([A, B, C, A, B, C, A]);
    expect(p.peek().rounds).toBe(2);
  });

  it("keeps going with a single picture in the list", () => {
    writeList(`${A}\n`);
    const p = picker();

    expect([sendDay(p, "2026-10-14"), sendDay(p, "2026-10-15"), sendDay(p, "2026-10-16")]).toEqual([A, A, A]);
  });

  it("a picture is used up only after a SUCCESSFUL send", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();

    // Day 1: picked, but delivery fails (markSent never called).
    clock = { at: day("2026-10-14") };
    expect(p.pick().url).toBe(A);
    expect(p.peek().sentThisRound).toBe(0);

    // Day 2: nothing was used up, so A is tried again.
    clock = { at: day("2026-10-15") };
    expect(p.pick().url).toBe(A);
  });

  it("the same picture is used all day: retries and restarts never change it", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();

    clock = { at: day("2026-10-14") };
    const first = p.pick();

    // retries during the delivery window
    expect(p.pick().url).toBe(A);
    expect(p.pick().url).toBe(A);

    // service restarted: a new picker with the same files
    expect(picker().pick().url).toBe(A);

    // delivered; still the same picture if asked again that day
    p.markSent(first);
    expect(picker().pick().url).toBe(A);

    // next day moves on
    expect(sendDay(p, "2026-10-15")).toBe(B);
  });

  it("days with no message (weekends) use nothing up", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();

    sendDay(p, "2026-10-16"); // Friday
    // Saturday and Sunday: the sender is never called.
    expect(sendDay(p, "2026-10-19")).toBe(B); // Monday
  });

  it("a restart between days keeps the round (state survives)", () => {
    writeList(`${A}\n${B}\n${C}\n`);

    sendDay(picker(), "2026-10-14");
    sendDay(picker(), "2026-10-15");

    expect(sendDay(picker(), "2026-10-16")).toBe(C);
  });
});

describe("editing the list while it runs", () => {
  it("new links join the current round", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();
    sendDay(p, "2026-10-14"); // A

    writeList(`${A}\n${B}\n${C}\n`);

    expect(sendDay(p, "2026-10-15")).toBe(B);
    expect(sendDay(p, "2026-10-16")).toBe(C);
  });

  it("removed links are forgotten, including from 'sent'", () => {
    writeList(`${A}\n${B}\n${C}\n`);
    const p = picker();
    sendDay(p, "2026-10-14"); // A used

    writeList(`${B}\n${C}\n`);

    expect(sendDay(p, "2026-10-15")).toBe(B);
    expect(p.peek()).toMatchObject({ listed: 2, sentThisRound: 1, remainingThisRound: 1 });
  });

  it("if today's chosen picture is removed from the list, another one is chosen", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();
    clock = { at: day("2026-10-14") };
    expect(p.pick().url).toBe(A);

    writeList(`${B}\n`);

    expect(p.pick().url).toBe(B);
  });
});

describe("fallback to the single picture (GOOD_MORNING_IMAGE_URL)", () => {
  it("no list file: behaves exactly as before and writes nothing", () => {
    const p = picker();

    expect(p.pick()).toEqual({ url: OLD, source: "fallback" });
    p.markSent(p.pick());
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(p.peek()).toMatchObject({ source: "fallback", next: OLD });
  });

  it("a list with no usable link falls back (and warns)", () => {
    writeList("# nothing here\nnot a link\n");

    expect(picker().pick()).toEqual({ url: OLD, source: "fallback" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("no list and no single picture is the same error as before", () => {
    expect(() => picker({ fallback: undefined }).pick()).toThrow("GOOD_MORNING_IMAGE_URL is not configured");
    expect(picker({ fallback: "   " }).peek().source).toBe("none");
  });

  it("the list wins when both exist", () => {
    writeList(`${A}\n`);

    expect(picker().pick()).toEqual({ url: A, source: "list" });
  });
});

describe("what you can see in the state folder", () => {
  it("a readable status file says what is next, what was sent and what is left", () => {
    writeList(`${A}\n${B}\n${C}\n`);
    const p = picker();
    sendDay(p, "2026-10-14");
    clock = { at: day("2026-10-15") };
    p.pick();

    const text = fs.readFileSync(path.join(dir, IMAGE_STATUS_FILE), "utf8");

    expect(text).toContain("Pictures in good-morning-images.txt: 3");
    expect(text).toContain("Already sent this round: 1");
    expect(text).toContain("Still to send this round: 2");
    expect(text).toMatch(/SENT THIS ROUND[\s\S]*1\. https:\/\/site\.example\/img\/a\.png/);
    expect(text).toMatch(/STILL TO SEND[\s\S]*1\. https:\/\/site\.example\/img\/b\.png/);
  });

  it("peek() reports the next picture and changes nothing", () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();

    expect(p.peek()).toMatchObject({ source: "list", listed: 2, next: A, sentThisRound: 0 });
    expect(fs.existsSync(path.join(dir, IMAGE_STATE_FILE))).toBe(false);
  });

  it("a damaged memory file starts a fresh round instead of failing", () => {
    writeList(`${A}\n${B}\n`);
    fs.writeFileSync(path.join(dir, IMAGE_STATE_FILE), "{ not json");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(picker().pick().url).toBe(A);
  });
});

describe("the Good Morning sender", () => {
  const card = (call: unknown[]) => {
    const body = JSON.parse(String((call[1] as { body: string }).body));
    const widgets = body.cardsV2[0].card.sections[0].widgets;

    return { text: body.text as string, image: widgets[0].image.imageUrl as string, button: widgets[1].buttonList.buttons[0].onClick.openLink.url as string };
  };

  beforeEach(() => {
    vi.stubEnv("GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL", "https://chat.googleapis.com/v1/spaces/SPACE/messages?key=k&token=t");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts the picture from the list, then uses it up", async () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    clock = { at: day("2026-10-14") };
    await new GoogleChatService(15_000, p).sendGoodMorningMessage("Good Morning Team");

    const sent = card(fetchSpy.mock.calls[0]!);
    expect(sent).toMatchObject({ text: "Good Morning Team", image: A, button: A });
    expect(p.peek()).toMatchObject({ sentThisRound: 1, remainingThisRound: 1 });

    clock = { at: day("2026-10-15") };
    await new GoogleChatService(15_000, p).sendGoodMorningMessage("Good Morning Team");
    expect(card(fetchSpy.mock.calls[1]!).image).toBe(B);
  });

  it("a failed delivery does not use the picture up, and the retry sends the same one", async () => {
    writeList(`${A}\n${B}\n`);
    const p = picker();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    clock = { at: day("2026-10-14") };
    const chat = new GoogleChatService(15_000, p);

    await expect(chat.sendGoodMorningMessage("hi")).rejects.toThrow(/429/);
    expect(p.peek().sentThisRound).toBe(0);

    await chat.sendGoodMorningMessage("hi");

    expect(card(fetchSpy.mock.calls[0]!).image).toBe(A);
    expect(card(fetchSpy.mock.calls[1]!).image).toBe(A);
    expect(p.peek().sentThisRound).toBe(1);
  });

  it("without a list it sends GOOD_MORNING_IMAGE_URL exactly as before", async () => {
    const p = picker();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await new GoogleChatService(15_000, p).sendGoodMorningMessage("hi");

    expect(card(fetchSpy.mock.calls[0]!).image).toBe(OLD);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("with neither a list nor a single picture it fails with the old error and posts nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(new GoogleChatService(15_000, picker({ fallback: undefined })).sendGoodMorningMessage("hi")).rejects.toThrow(
      "GOOD_MORNING_IMAGE_URL is not configured",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
