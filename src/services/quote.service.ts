import fs from "node:fs";
import path from "node:path";

import {
  generateSimpleLLMResponse,
  isLlmConfigured,
} from "./quoteLlm.js";
import { resolveStatePath } from "../config/runtimeConfig.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "by",
  "is", "are", "be", "it", "its", "our", "we", "us", "your", "you",
  "that", "this", "into", "from", "at", "as", "or", "not", "every",
  "each", "one", "what", "when", "their", "they", "them", "more", "most",
]);

export interface Quote {
  quote: string;
}

interface QuoteState {
  dailyQuotes: Record<string, Quote>;
  usedQuotes: string[];
}

// How many earlier quotes the AI is shown as "do not repeat these".
const RECENT_QUOTES_FOR_PROMPT = 30;

// Themes rotated day by day so the AI writes about different things.
const DAILY_THEMES = [
  "consistency",
  "ownership",
  "teamwork",
  "learning",
  "excellence and quality",
  "leadership",
  "discipline and focus",
  "meaningful progress",
  "clear communication",
  "accountability",
  "adaptability",
  "helping colleagues succeed",
];

export interface QuoteServiceOptions {
  stateFile?: string;
  now?: () => Date;
  // Produces a new AI quote for a prompt (default: the configured AI).
  generate?: (prompt: string) => Promise<string>;
  aiEnabled?: () => boolean;
}

export class QuoteService {
  private readonly stateFile: string;

  private readonly now: () => Date;

  private readonly generate: (prompt: string) => Promise<string>;

  private readonly aiEnabled: () => boolean;

  constructor(options: QuoteServiceOptions = {}) {
    this.stateFile =
      options.stateFile ??
      resolveStatePath(".good-morning-quote-state.json");
    this.now = options.now ?? (() => new Date());
    this.generate =
      options.generate ?? generateSimpleLLMResponse;
    this.aiEnabled = options.aiEnabled ?? isLlmConfigured;
  }

  // Used when the AI is not configured or fails. All distinct; they are
  // rotated so none repeats until every one has been used.
  private readonly fallbackQuotes: Quote[] = [
    { quote: "The quality of our work is shaped by the consistency we bring to it every day." },
    { quote: "Great work begins with ownership, grows through collaboration, and improves through consistency." },
    { quote: "Progress is built through small actions taken consistently toward a clear goal." },
    { quote: "Strong teams turn individual effort into shared progress through trust and accountability." },
    { quote: "Every challenge gives us an opportunity to learn, improve, and create better results." },
    { quote: "Clear priorities turn a busy day into a productive one; decide what matters most and give it your full attention." },
    { quote: "Reliable teams are built on simple promises kept, one commitment and one delivery at a time." },
    { quote: "Asking a good question early often saves hours of work later; curiosity is a quiet form of efficiency." },
    { quote: "Excellence is rarely one big leap; it is the steady habit of doing ordinary things unusually well." },
    { quote: "When we share what we know freely, the whole team moves faster and makes fewer avoidable mistakes." },
    { quote: "Ownership means seeing a problem and treating its solution as your responsibility, not someone else's task." },
    { quote: "Feedback given with care and received with an open mind is one of the fastest ways any team improves." },
    { quote: "Discipline is choosing what we want most over what we want right now, especially when no one is watching." },
    { quote: "A well-documented decision today prevents confusion tomorrow and helps the next person build on our work." },
    { quote: "Small improvements made every week compound into results that surprise even the people who made them." },
    { quote: "The best solutions often come from listening carefully before deciding how to act." },
    { quote: "Respecting deadlines is respecting colleagues, because every delay quietly moves work onto someone else." },
    { quote: "Mistakes are useful when we examine them honestly, fix the cause, and share the lesson with others." },
    { quote: "Calm focus beats frantic activity; steady attention on the right task produces better work than rushing." },
    { quote: "A team that trusts each other can disagree openly, decide quickly, and commit fully to the outcome." },
    { quote: "Quality is not inspected in at the end; it is built into every step by people who care about the result." },
    { quote: "Learning something new each week keeps our skills sharp and our thinking open to better ways of working." },
    { quote: "Clear communication turns individual effort into coordinated progress and prevents work from being done twice." },
    { quote: "Leadership shows up in everyday choices: taking responsibility, supporting others, and setting a steady example." },
    { quote: "Finishing what we start builds trust faster than starting many things we never complete." },
    { quote: "Good processes free people to think about hard problems instead of repeating the same easy ones." },
    { quote: "Helping a colleague succeed is never a distraction; it is part of how the whole team wins." },
    { quote: "Preparation turns pressure into confidence; the work done in advance is what makes difficult days manageable." },
    { quote: "Simple, clear work is often the hardest to produce and the easiest for everyone else to build upon." },
    { quote: "Accountability is not about blame; it is about owning outcomes and learning how to make them better." },
    { quote: "Consistency earns trust slowly and loses it quickly, so every reliable day is an investment worth making." },
    { quote: "The courage to say what is not working is the first step toward making it work well." },
    { quote: "Measure progress by value delivered to others, not by how busy the day felt." },
    { quote: "Patience with people and persistence with problems together create results that last." },
    { quote: "Every task done carefully is a message to the team that their time and trust are respected." },
    { quote: "Great outcomes rarely depend on one person; they come from many people doing their part with pride." },
    { quote: "Adaptability is a strength: plans will change, but clear goals help us adjust without losing direction." },
    { quote: "Check the details once more before sharing; small accuracy saves large corrections later." },
    { quote: "Growth happens just outside comfort; each unfamiliar task we take on widens what we can contribute." },
    { quote: "Respect grows when we listen to understand, not only to reply." },
    { quote: "A focused hour on the right problem is worth more than a scattered day on many small ones." },
    { quote: "Reliable systems come from people who test assumptions instead of trusting them." },
    { quote: "Recognising good work in others builds a culture where good work becomes the normal standard." },
    { quote: "Take ownership of your learning; the skills we build today shape the opportunities available tomorrow." },
    { quote: "Collaboration works best when everyone knows the goal, their role, and how to ask for help." },
    { quote: "Doing the right thing slowly is better than doing the wrong thing quickly and repeating it." },
    { quote: "Every improvement starts with noticing something that could be better and deciding to act on it." },
    { quote: "Steady effort through ordinary days is what makes extraordinary days possible." },
    { quote: "The standard we walk past is the standard we accept; small corrections keep quality high." },
    { quote: "Shared goals turn separate tasks into one direction and make every contribution count." },
  ];

  async getDailyQuote(): Promise<Quote> {
    const today = this.getToday();
    const state = this.loadState();

    // Return today's existing quote if already generated.
    if (state.dailyQuotes[today]) {
      return state.dailyQuotes[today];
    }

    const usedQuotes = new Set(state.usedQuotes);

    // Every quote used before (newest first), to avoid repeats.
    const previous = this.getPreviousQuotes(state);

    // No AI configured: go straight to a built-in quote.
    const attempts = this.aiEnabled() ? 5 : 0;

    if (attempts === 0) {
      console.log(
        "AI is not configured (LLM_BASE_URL / LLM_API_KEY); using a built-in Good Morning quote.",
      );
    }

    // Try multiple times to generate a new quote.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const quote = await this.generateQuote(
          previous.slice(0, RECENT_QUOTES_FOR_PROMPT),
          this.getTheme(today),
        );

        if (!quote) {
          continue;
        }

        const key = this.getQuoteKey(quote);

        // Never reuse a quote, or a near-copy of an earlier one
        // (e.g. same opening with a slightly different ending).
        if (
          usedQuotes.has(key) ||
          previous.some((old) => this.isTooSimilar(quote.quote, old))
        ) {
          console.log(
            `Quote attempt ${attempt} was too similar to an earlier quote; trying again.`,
          );
          continue;
        }

        state.dailyQuotes[today] = quote;
        state.usedQuotes.push(key);

        this.saveState(state);

        return quote;
      } catch (error) {
        console.error(
          `Quote generation attempt ${attempt} failed:`,
          error,
        );
      }
    }

    // Fallback if the LLM is unavailable.
    const fallback = this.getFallbackQuote(state);

    state.dailyQuotes[today] = fallback;
    state.usedQuotes.push(
      this.getQuoteKey(fallback),
    );

    this.saveState(state);

    return fallback;
  }

  private async generateQuote(
    recentQuotes: string[],
    theme: string,
  ): Promise<Quote | null> {
    const avoid =
      recentQuotes.length > 0
        ? `
Today's theme: ${theme}.

These quotes were ALREADY used. Do NOT repeat them, and do NOT reuse
their opening words, sentence structure or main phrases:
${recentQuotes.map((q) => `- ${q}`).join("\n")}
`
        : `
Today's theme: ${theme}.
`;

    const prompt = `
Generate ONE original professional motivational quote for an organization's
daily Good Morning message.

Requirements:
- Suitable for a workplace.
- Professional and mature.
- Relevant to consistency, ownership, teamwork, learning, excellence,
  leadership, discipline, or meaningful progress.
- Positive but NOT cheesy.
- Do not mention mornings.
- Do not use emojis.
- Do not use hashtags.
- Do not use politics, religion, relationships, romance, or personal life.
- Keep it between 15 and 30 words.
- It must sound natural when displayed to employees.
- Do not copy a famous quotation.
- Create an original statement.
${avoid}
Return ONLY valid JSON in exactly this format:

{
  "quote": "your original quote"
}
`;

    const response = await this.generate(prompt);

    if (!response) {
      return null;
    }

    const cleaned = response
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as {
        quote?: unknown;
      };

      if (
        typeof parsed.quote !== "string" ||
        parsed.quote.trim().length < 15 ||
        parsed.quote.trim().length > 250
      ) {
        return null;
      }

      return {
        quote: parsed.quote.trim(),
      };
    } catch {
      return null;
    }
  }

  // Never-used built-in quote first; if all have been used, the one
  // used longest ago. Skips anything too similar to recent quotes.
  private getFallbackQuote(state: QuoteState): Quote {
    const lastUsed = new Map<string, string>();

    for (const [date, quote] of Object.entries(state.dailyQuotes)) {
      const key = this.getQuoteKey(quote);
      const seen = lastUsed.get(key);

      if (!seen || date > seen) {
        lastUsed.set(key, date);
      }
    }

    for (const key of state.usedQuotes) {
      if (!lastUsed.has(key)) {
        lastUsed.set(key, "0000-00-00");
      }
    }

    const recent = this.getPreviousQuotes(state).slice(
      0,
      RECENT_QUOTES_FOR_PROMPT,
    );

    const ranked = this.fallbackQuotes
      .map((quote, index) => ({
        quote,
        index,
        used: lastUsed.get(this.getQuoteKey(quote)) ?? "",
      }))
      .sort(
        (a, b) =>
          a.used.localeCompare(b.used) || a.index - b.index,
      );

    const pick =
      ranked.find(
        (item) =>
          !recent.some((old) =>
            this.isTooSimilar(item.quote.quote, old),
          ),
      ) ?? ranked[0]!;

    return pick.quote;
  }

  // All earlier quotes, newest first.
  private getPreviousQuotes(state: QuoteState): string[] {
    return Object.entries(state.dailyQuotes)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([, quote]) => quote.quote);
  }

  private getTheme(today: string): string {
    const day = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
    return DAILY_THEMES[day % DAILY_THEMES.length]!;
  }

  // True for the same quote or a near-copy: identical opening words, or
  // most of the meaningful words shared.
  isTooSimilar(a: string, b: string): boolean {
    const wordsA = this.words(a);
    const wordsB = this.words(b);

    if (wordsA.length === 0 || wordsB.length === 0) {
      return false;
    }

    const opening = 5;

    if (
      wordsA.length >= opening &&
      wordsB.length >= opening &&
      wordsA.slice(0, opening).join(" ") ===
        wordsB.slice(0, opening).join(" ")
    ) {
      return true;
    }

    const setA = new Set(wordsA.filter((w) => !STOP_WORDS.has(w)));
    const setB = new Set(wordsB.filter((w) => !STOP_WORDS.has(w)));
    const smaller = Math.min(setA.size, setB.size);

    if (smaller === 0) {
      return false;
    }

    let shared = 0;

    for (const word of setA) {
      if (setB.has(word)) {
        shared++;
      }
    }

    return shared / smaller >= 0.6;
  }

  private words(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[’']/g, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  private getQuoteKey(quote: Quote): string {
    return quote.quote
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  private loadState(): QuoteState {
    try {
      if (!fs.existsSync(this.stateFile)) {
        return {
          dailyQuotes: {},
          usedQuotes: [],
        };
      }

      const raw = fs.readFileSync(
        this.stateFile,
        "utf-8",
      );

      const data =
        JSON.parse(raw) as Partial<QuoteState>;

      return {
        dailyQuotes:
          data.dailyQuotes &&
          typeof data.dailyQuotes === "object"
            ? data.dailyQuotes
            : {},

        usedQuotes: Array.isArray(
          data.usedQuotes,
        )
          ? data.usedQuotes.filter(
              (item): item is string =>
                typeof item === "string",
            )
          : [],
      };
    } catch (error) {
      // Keep the unreadable file instead of letting the next save
      // overwrite it, so the quote history can still be recovered.
      const kept = `${this.stateFile}.corrupt-${Date.now()}`;

      try {
        fs.renameSync(this.stateFile, kept);
      } catch {
        // ignore: an empty state is returned below either way
      }

      console.error(
        `Failed to load quote state (file kept as ${kept}):`,
        error,
      );

      return {
        dailyQuotes: {},
        usedQuotes: [],
      };
    }
  }

  private saveState(state: QuoteState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), {
        recursive: true,
      });

      // Temp file then rename (same approach as the Good Morning state
      // file), so a crash mid-write can't leave a broken history file.
      const tempFile = `${this.stateFile}.tmp`;

      fs.writeFileSync(
        tempFile,
        JSON.stringify(
          state,
          null,
          2,
        ),
        "utf-8",
      );

      fs.renameSync(tempFile, this.stateFile);
    } catch (error) {
      console.error(
        "Failed to save quote state:",
        error,
      );
    }
  }

  private getToday(): string {
    const parts =
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(this.now())
        .reduce<Record<string, string>>(
          (result, part) => {
            if (part.type !== "literal") {
              result[part.type] =
                part.value;
            }

            return result;
          },
          {},
        );

    return `${parts.year}-${parts.month}-${parts.day}`;
  }
}

export const quoteService =
  new QuoteService();