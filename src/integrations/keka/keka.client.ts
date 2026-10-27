import {
  DEFAULT_KEKA_AUTH_URL,
  normaliseEmail,
} from "../../config/runtimeConfig.js";

// ---------------------------------------------------------------
// Keka (READ-ONLY): the current employee list.
//
// Auth (Keka API-key method):
//   POST <KEKA_AUTH_URL>  form: grant_type=kekaapi, scope=kekaapi,
//                         client_id, client_secret, api_key
//   → access_token (Bearer, about 24 h; cached and renewed)
// Employees:
//   GET <KEKA_BASE_URL>/api/v1/hris/employees?employmentStatus=Working
//       &pageNumber=N&pageSize=200
//
// employmentStatus 0 = Working, 1 = Relieved (Keka docs). Only
// Working employees are returned.
//
// Nothing here ever returns a PARTIAL list: any failed page, bad
// response or count mismatch throws, and the caller sends nothing.
// Credentials are never logged or put in an error message.
// ---------------------------------------------------------------

export const KEKA_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const MAX_ATTEMPTS = 3;
const TOKEN_SAFETY_MS = 60_000;

const EMPLOYMENT_STATUS_WORKING = 0;

export interface KekaEmployee {
  id: string;
  name: string;
  // Lower-case, trimmed. The matching key across Keka, PMS and the
  // Time Tracker.
  email: string;
}

export interface KekaClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

class RetryableError extends Error {}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class KekaClient {
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: KekaClientOptions = {}) {
    const env = options.env ?? process.env;
    const get = (name: string) => (env[name] ?? "").trim();

    for (const name of [
      "KEKA_BASE_URL",
      "KEKA_CLIENT_ID",
      "KEKA_CLIENT_SECRET",
      "KEKA_API_KEY",
    ]) {
      if (!get(name)) {
        throw new Error(`${name} is not configured`);
      }
    }

    this.baseUrl = get("KEKA_BASE_URL").replace(/\/+$/, "");
    this.authUrl = get("KEKA_AUTH_URL") || DEFAULT_KEKA_AUTH_URL;
    this.clientId = get("KEKA_CLIENT_ID");
    this.clientSecret = get("KEKA_CLIENT_SECRET");
    this.apiKey = get("KEKA_API_KEY");
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? KEKA_TIMEOUT_MS;
  }

  // All current (Working) employees, or an error.
  async getActiveEmployees(): Promise<KekaEmployee[]> {
    const employees: KekaEmployee[] = [];
    const seen = new Set<string>();
    let skippedNoEmail = 0;
    let fetched = 0;
    let totalRecords = -1;
    let page = 1;
    let totalPages = 1;

    do {
      const body = await this.getJson(
        `/api/v1/hris/employees?employmentStatus=Working&pageNumber=${page}&pageSize=${PAGE_SIZE}`,
      );

      if (
        !body ||
        typeof body !== "object" ||
        (body as { succeeded?: unknown }).succeeded !== true ||
        !Array.isArray((body as { data?: unknown }).data)
      ) {
        throw new Error(
          "Keka returned an unexpected employee response (not a successful list).",
        );
      }

      const parsed = body as {
        data: unknown[];
        totalPages?: unknown;
        totalRecords?: unknown;
      };

      if (
        !Number.isInteger(parsed.totalPages) ||
        !Number.isInteger(parsed.totalRecords)
      ) {
        throw new Error(
          "Keka employee response has no page/record counts, so completeness cannot be checked.",
        );
      }

      totalPages = parsed.totalPages as number;
      totalRecords = parsed.totalRecords as number;

      if (totalPages > MAX_PAGES) {
        throw new Error(
          `Keka reports ${totalPages} pages of employees; refusing to continue.`,
        );
      }

      for (const raw of parsed.data) {
        fetched++;

        if (!raw || typeof raw !== "object") {
          throw new Error("Keka returned an employee entry that is not an object.");
        }

        const record = raw as Record<string, unknown>;

        // The filter should already return only Working people; check
        // anyway so a changed API can never list a relieved employee.
        if (record.employmentStatus !== EMPLOYMENT_STATUS_WORKING) {
          throw new Error(
            "Keka returned an employee that is not in Working status; the response cannot be trusted.",
          );
        }

        const email = normaliseEmail(record.email);

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          // Cannot be matched with PMS / Time Tracker, so cannot be
          // evaluated. Counted and reported, never guessed.
          skippedNoEmail++;
          continue;
        }

        if (seen.has(email)) {
          continue;
        }

        seen.add(email);

        const display = String(record.displayName ?? "").trim();
        const full = [record.firstName, record.lastName]
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join(" ");

        employees.push({
          id: String(record.id ?? ""),
          name: display || full || email,
          email,
        });
      }

      page++;
    } while (page <= totalPages);

    if (fetched !== totalRecords) {
      throw new Error(
        `Keka employee list is incomplete (${fetched} received, ${totalRecords} expected).`,
      );
    }

    if (skippedNoEmail > 0) {
      console.warn(
        `Keka: ${skippedNoEmail} working employee(s) have no usable email and cannot be evaluated.`,
      );
    }

    if (employees.length === 0) {
      throw new Error("Keka returned no working employees.");
    }

    return employees;
  }

  // ---------------------------------------------------------------

  private async getToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.token &&
      this.now() < this.token.expiresAt
    ) {
      return this.token.value;
    }

    const body = await this.withRetries(async () => {
      const response = await this.request(this.authUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "Mozilla",
        },
        body: new URLSearchParams({
          grant_type: "kekaapi",
          scope: "kekaapi",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          api_key: this.apiKey,
        }),
      });

      return this.readJson(response, "Keka sign-in");
    });

    const token = (body as { access_token?: unknown }).access_token;
    const expiresIn = Number(
      (body as { expires_in?: unknown }).expires_in,
    );

    if (typeof token !== "string" || token === "") {
      throw new Error("Keka sign-in did not return an access token.");
    }

    this.token = {
      value: token,
      expiresAt:
        this.now() +
        (Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn * 1000
          : 3_600_000) -
        TOKEN_SAFETY_MS,
    };

    return token;
  }

  private async getJson(path: string): Promise<unknown> {
    let refreshed = false;

    for (;;) {
      const token = await this.getToken(refreshed);

      try {
        return await this.withRetries(async () => {
          const response = await this.request(
            `${this.baseUrl}${path}`,
            {
              method: "GET",
              headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
                "user-agent": "Mozilla",
              },
            },
          );

          return this.readJson(response, "Keka employees");
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("HTTP 401") &&
          !refreshed
        ) {
          // Token expired early: sign in again once.
          refreshed = true;
          continue;
        }

        throw error;
      }
    }
  }

  private async request(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";

      throw new RetryableError(
        name === "TimeoutError" || name === "AbortError"
          ? `Keka did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`
          : "Keka could not be reached (network error)",
      );
    }
  }

  private async readJson(
    response: Response,
    what: string,
  ): Promise<unknown> {
    if (!response.ok) {
      const text = `${what} failed: HTTP ${response.status}`;

      if (response.status >= 500 || response.status === 429) {
        throw new RetryableError(text);
      }

      throw new Error(text);
    }

    try {
      return await response.json();
    } catch {
      // e.g. an HTML error page with status 200: never treat as data.
      throw new RetryableError(`${what} returned a response that is not JSON`);
    }
  }

  private async withRetries<T>(task: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await task();
      } catch (error) {
        lastError = error;

        if (!(error instanceof RetryableError)) {
          throw error;
        }

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(1_000 * 2 ** (attempt - 1));
        }
      }
    }

    throw lastError instanceof Error
      ? new Error(lastError.message)
      : new Error("Keka request failed");
  }
}
