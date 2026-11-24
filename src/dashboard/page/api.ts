/**
 * The page's client of the dashboard's API: `POST /api/v1/<operation>` with `{ "args": [...] }`
 * and the token as `Authorization: Bearer <token>`. The rack's answers, and the dashboard's own
 * failures, come back as one {@link Outcome}. This module uses no API of the DOM or of Bun: the
 * page hands it `fetch`, and tests a fake.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#what-the-dashboard-forwards
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */
import type { SlotStatus } from "../../reports.ts";
import { visibleText } from "./format.ts";
import { bearer } from "./token.ts";

/** An error as the rack sends it, `{ code, message, data? }`. */
export type RackFailure = NonNullable<SlotStatus["error"]>;

/** How one request to the dashboard ended. */
export type Outcome<T = unknown> =
  /** The rack answered `{ ok: true, value }`. */
  | { kind: "value"; value: T }
  /** The rack answered `{ ok: false, error }`: the operation failed with a code of the rack's. */
  | { kind: "error"; error: RackFailure }
  /**
   * The request failed before the rack could answer it: the dashboard's HTTP status, such as 502
   * when no rack answers, or 0 when the dashboard didn't answer at all; and a reason for people.
   * `timedOut` marks a request that the page itself gave up on after its wait.
   */
  | { kind: "failed"; status: number; reason: string; timedOut?: true };

/** What the client passes to {@link Fetch}; the DOM's `RequestInit` takes it as it is. */
export interface FetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** No cookie goes with a request: the bearer token alone authenticates the page. */
  credentials: "omit";
  cache: "no-store";
  signal?: AbortSignal;
}

/** The part of a `Response` that the client reads. */
export interface FetchAnswer {
  status: number;
  text(): Promise<string>;
}

/** The `fetch` that the client sends its requests with. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchAnswer>;

/** The path under which the dashboard serves its API. */
export const API_PATH = "/api/v1/";

/**
 * How long the page waits for the answer to a read, in ms: longer than the dashboard's 60 s, so
 * that the dashboard's 504 comes first, and only a dashboard that stopped answering hits it.
 */
export const READ_WAIT_MS = 70_000;

/**
 * How long the page waits for the answer to an operation, in ms: longer than the dashboard's 10
 * minutes, for the same reason as {@link READ_WAIT_MS}.
 */
export const OPERATION_WAIT_MS = 610_000;

/** Options of a {@link Client}. */
export interface ClientOptions {
  /** The token that the dashboard printed in its URL. */
  token: string;
  /** Sends a request; the page passes the browser's `fetch`. */
  fetch: Fetch;
  /**
   * Makes the signal that ends a request after `ms`; by default `AbortSignal.timeout`. A test
   * returns `undefined` for none.
   */
  timeout?: (ms: number) => AbortSignal | undefined;
}

/** Sends the page's requests to the dashboard, one call per request. */
export class Client {
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #timeout: (ms: number) => AbortSignal | undefined;

  /** @param options The token, the `fetch` to send with, and how a request times out. */
  constructor(options: ClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
  }

  /**
   * Asks the dashboard to run an operation, or to answer its own `about`.
   *
   * @param op The operation, such as `status` or `restart`.
   * @param args Its arguments.
   * @param waitMs How long to wait for the answer: {@link READ_WAIT_MS} by default, and
   *   {@link OPERATION_WAIT_MS} for an operation.
   * @returns How the request ended; it never rejects.
   */
  async call<T = unknown>(op: string, args: unknown[], waitMs = READ_WAIT_MS): Promise<Outcome<T>> {
    let answer: FetchAnswer;
    let text: string;
    try {
      const signal = this.#timeout(waitMs);
      answer = await this.#fetch(`${API_PATH}${op}`, {
        method: "POST",
        headers: { authorization: bearer(this.#token), "content-type": "application/json" },
        body: JSON.stringify({ args }),
        credentials: "omit",
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
      });
      text = await answer.text();
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
        return {
          kind: "failed",
          status: 0,
          reason: `the dashboard didn't answer within ${Math.round(waitMs / 1000)} s`,
          timedOut: true,
        };
      }
      return {
        kind: "failed",
        status: 0,
        reason: "the dashboard doesn't answer; it may have stopped",
      };
    }
    if (answer.status !== 200) {
      return {
        kind: "failed",
        status: answer.status,
        reason: failureReason(op, answer.status, text),
      };
    }
    return rackAnswer<T>(text);
  }
}

/** The outcome that the body of a 200 holds: the rack's answer, or a failure when it isn't one. */
function rackAnswer<T>(text: string): Outcome<T> {
  const malformed: Outcome<T> = {
    kind: "failed",
    status: 200,
    reason: "the dashboard answered with a body that isn't an answer of the rack",
  };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return malformed;
  }
  if (typeof body !== "object" || body === null) return malformed;
  const { ok, value, error } = body as { ok?: unknown; value?: unknown; error?: unknown };
  if (ok === true) return { kind: "value", value: value as T };
  if (ok === false && isRackFailure(error)) return { kind: "error", error };
  return malformed;
}

/**
 * Whether a value is an error as the rack sends it, with a string `code` and `message`.
 *
 * @param value A value from an answer.
 * @returns `true` for `{ code: string, message: string, data? }`.
 */
export function isRackFailure(value: unknown): value is RackFailure {
  if (typeof value !== "object" || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

/** The most characters of the dashboard's own message that the page shows. */
const REASON_LIMIT = 500;

/** Why the dashboard didn't pass the rack's answer on, from its status and body. */
function failureReason(op: string, status: number, text: string): string {
  const message = dashboardMessage(text);
  switch (status) {
    case 400:
      return `the dashboard refused the arguments of ${op} (400)`;
    case 401:
      return "the dashboard refused the page's token (401)";
    case 403:
      return "the dashboard refused this page (403)";
    case 404:
      return `the dashboard doesn't forward ${op} (404)`;
    case 405:
      return "the dashboard takes only POST (405)";
    case 413:
      return "the request was too large for the dashboard (413)";
    case 502:
      return message ?? "no rack answers (502)";
    case 503:
      return message ?? "16 requests already wait for the rack (503)";
    case 504:
      return message ?? "the rack didn't answer in time (504)";
    default:
      return message ?? `the dashboard answered with HTTP ${status}`;
  }
}

/** The message of a body `{ "error": "<message>" }`, cut to {@link REASON_LIMIT} characters. */
function dashboardMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: unknown } | null;
    const message = body?.error;
    if (typeof message !== "string" || message === "") return null;
    const shown = visibleText(message);
    return shown.length > REASON_LIMIT ? `${shown.slice(0, REASON_LIMIT - 1)}…` : shown;
  } catch {
    // An empty body, or one that isn't JSON, holds no message.
    return null;
  }
}
