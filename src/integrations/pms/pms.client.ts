import type { PmsTask } from "./pms.types.js";

// ---------------------------------------------------------------
// PMS (READ-ONLY), same call as the AIOS backend's pms.client:
//   GET <PMS_TASKS_API_URL>?api=1&key=<PMS_API_KEY>&action=tasks
//
// The PMS endpoint is a Google Apps Script and sometimes times out or
// answers a transient 404 HTML page, then works on retry. So:
//   - a time limit on every request
//   - a few retries with a growing pause for transient problems
//   - the answer must be real JSON {ok: true, <list>: [...]}; an HTML
//     page or any failure is an ERROR, never "nothing found"
//   - an empty list is also rejected: PMS always has tasks and members,
//     so an empty one means a broken response, and trusting it would
//     list everyone (or no one)
// The API key is never logged or put in an error message.
// ---------------------------------------------------------------

export const PMS_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 4;

export interface PmsClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class Transient extends Error {}

interface ListSpec {
  // PMS "action" parameter and the key of the list in the answer.
  action: "tasks";
  // For error messages: "Tasks" → "PMS Tasks API ...", "task list".
  label: string;
  noun: string;
}

class PmsListClient<T> {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    options: PmsClientOptions,
    private readonly spec: ListSpec,
  ) {
    const env = options.env ?? process.env;
    const apiKey = (env.PMS_API_KEY ?? "").trim();
    const baseUrl = (env.PMS_TASKS_API_URL ?? "").trim();

    if (!apiKey) {
      throw new Error("PMS_API_KEY is not configured");
    }

    if (!baseUrl) {
      throw new Error("PMS_TASKS_API_URL is not configured");
    }

        const url = new URL(baseUrl);
    url.searchParams.set("api", "1");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("action", spec.action);

    this.url = url.toString();
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? PMS_TIMEOUT_MS;
  }

  protected async getList(): Promise<T[]> {
    let lastMessage = "PMS request failed";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.once();
      } catch (error) {
        lastMessage =
          error instanceof Error ? error.message : String(error);

        if (!(error instanceof Transient)) {
          throw new Error(lastMessage);
        }

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(2_000 * 2 ** (attempt - 1));
        }
      }
    }

    throw new Error(
      `${lastMessage} (gave up after ${MAX_ATTEMPTS} attempts)`,
    );
  }

  private async once(): Promise<T[]> {
    const { label, noun, action } = this.spec;
    let response: Response;

    try {
      response = await this.fetchFn(this.url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";

      throw new Transient(
        name === "TimeoutError" || name === "AbortError"
          ? `PMS did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`
          : "PMS could not be reached (network error)",
      );
    }

    if (!response.ok) {
      // Includes the transient 404 HTML page from the Apps Script.
      throw new Transient(`PMS ${label} API request failed: HTTP ${response.status}`);
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new Transient(
        `PMS ${label} API returned a response that is not JSON (for example an HTML error page)`,
      );
    }

    const parsed = body as Record<string, unknown> | null;

    if (!parsed || parsed.ok !== true) {
      throw new Transient(`PMS ${label} API did not report success`);
    }

    const list = parsed[action];

    if (!Array.isArray(list)) {
      throw new Transient(`PMS ${label} API response has no ${noun}`);
    }

    if (list.length === 0) {
      throw new Transient(
        `PMS ${label} API returned an empty ${noun}, which is treated as an unreliable response`,
      );
    }

    return list as T[];
  }
}

export class PmsTasksClient extends PmsListClient<PmsTask> {
  constructor(options: PmsClientOptions = {}) {
    super(options, { action: "tasks", label: "Tasks", noun: "task list" });
  }

  getTasks(): Promise<PmsTask[]> {
    return this.getList();
  }
}
