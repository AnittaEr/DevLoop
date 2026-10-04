/**
 * Fixture data and the fake transport used to exercise the plugin.
 *
 * TEST-ONLY. Every value here is invented: the repository, the issue numbers,
 * the logins and the URLs. Nothing in this file performs network access, and
 * the one token-shaped string it needs is obviously synthetic (hyphenated
 * English prose, no long alphanumeric run), matching the convention in
 * `src/core/credentials/fakes.ts`.
 */

import type {
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from "../transport";

/** The repository the fixtures describe. */
export const FIXTURE_REPOSITORY = "acme/widgets";

/** A synthetic, obviously-not-real credential. */
export const FIXTURE_TOKEN = "github_pat_-not-a-real-fixture-token-1";

/** One canned HTTP response, keyed by the `page` query parameter. */
export interface FixtureResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A fake transport that serves canned responses and records every request it
 * received, so a test can assert on the parsed result AND on the request the
 * plugin actually built.
 */
export class FakeHttpTransport implements HttpTransport {
  /** Every request received, in order. */
  readonly requests: TransportRequest[] = [];

  private readonly byPage: Record<string, FixtureResponse>;
  private readonly fallback: FixtureResponse | undefined;

  constructor(options: {
    byPage: Record<string, FixtureResponse>;
    fallback?: FixtureResponse;
  }) {
    this.byPage = options.byPage;
    this.fallback = options.fallback;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const page = request.query["page"] ?? "1";
    const canned = this.byPage[page] ??
      this.fallback ?? { body: "[]", status: 200 };
    return {
      status: canned.status ?? 200,
      headers: canned.headers ?? {},
      body: canned.body,
    };
  }
}

/**
 * One fixture issue. `overrides` wins field by field, so a test can take the
 * default shape and change exactly the one thing it is about.
 */
export function fixtureIssue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1001,
    number: 42,
    title: "Widget explodes on save",
    state: "open",
    html_url: "https://code.example/acme/widgets/issues/42",
    created_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-01-03T03:04:05Z",
    closed_at: null,
    comments: 2,
    labels: [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ],
    user: { login: "ada", id: 7, type: "User" },
    ...overrides,
  };
}

/** A fixture that is a change proposal rather than a plain issue. */
export function fixtureProposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return fixtureIssue({
    id: 2002,
    number: 43,
    title: "Make the widget configurable",
    html_url: "https://code.example/acme/widgets/pull/43",
    pull_request: {
      html_url: "https://code.example/acme/widgets/pull/43",
      draft: false,
    },
    ...overrides,
  });
}

/** Serialise a page of fixture items into a JSON body. */
export function pageBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify(items);
}

/** A page of exactly `size` distinct fixture issues. */
export function fullPage(
  size: number,
  startNumber = 1,
): Record<string, unknown>[] {
  return Array.from({ length: size }, (_, index) => {
    const number = startNumber + index;
    return fixtureIssue({
      id: 1000 + number,
      number,
      title: `Fixture issue ${number}`,
      html_url: `https://code.example/acme/widgets/issues/${number}`,
    });
  });
}
