/**
 * The HTTP seam the GitHub plugin depends on.
 *
 * The plugin never calls `fetch` itself. It takes a {@link HttpTransport} in
 * its constructor, which is what makes the fetch path testable with canned
 * JSON and no network: a test injects a fake transport, production injects the
 * `fetch`-backed one at the composition root.
 *
 * Everything in this file is provider-shaped on purpose. It lives inside
 * `src/plugins/github/**` precisely so that no core module ever has to know
 * that a request carries a `token`, a `status` or a `Link` header.
 */

/** A single outbound request, in the shape the plugin needs it. */
export interface TransportRequest {
  /** Path below the API root, e.g. `/repos/octocat/hello/issues`. */
  readonly path: string;
  /** Query parameters, already stringified. */
  readonly query: Readonly<Record<string, string>>;
  /**
   * The credential to present. Handed straight to the transport and never
   * stored, logged, or interpolated into any error the plugin raises.
   */
  readonly token: string;
}

/**
 * A single inbound response.
 *
 * `headers` keys are expected lowercased; {@link normaliseHeaders} does that
 * for a real `Headers` object. Header lookup is case-sensitive by design, so
 * the normalisation is part of the contract rather than an implementation
 * detail a fake could quietly skip.
 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Raw response body, unparsed. The plugin owns JSON parsing. */
  readonly body: string;
}

/**
 * The single dependency the plugin has on the network.
 *
 * Deliberately one method: a second method would be a second seam for a fake
 * to have to implement, and a fake that implements only part of the interface
 * is a test that stops testing.
 */
export interface HttpTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

/** Lowercase every header name so `response.headers["link"]` is reliable. */
export function normaliseHeaders(
  headers: Iterable<readonly [string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** What {@link createFetchTransport} needs, so a test can supply its own. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
  },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

/** The API root. GitHub Enterprise would override this at the composition root. */
export const DEFAULT_API_ROOT = "https://api.github.com";

export interface FetchTransportOptions {
  readonly apiRoot?: string;
  readonly fetchImpl?: FetchLike;
  readonly userAgent?: string;
}

/**
 * Production transport built on the platform `fetch`.
 *
 * This function performs network access and is therefore never called from a
 * test: the tests inject a fake {@link HttpTransport} instead, which is why
 * `bun run test` needs no network and no token.
 */
export function createFetchTransport(
  options: FetchTransportOptions = {},
): HttpTransport {
  const apiRoot = options.apiRoot ?? DEFAULT_API_ROOT;
  const userAgent = options.userAgent ?? "DevLoop";
  const fetchImpl: FetchLike | undefined =
    options.fetchImpl ??
    (typeof globalThis.fetch === "undefined"
      ? undefined
      : (globalThis.fetch as unknown as FetchLike));

  if (fetchImpl === undefined) {
    throw new Error(
      "createFetchTransport: no fetch implementation available in this runtime",
    );
  }

  return {
    async request(request: TransportRequest): Promise<TransportResponse> {
      const query = new URLSearchParams(request.query).toString();
      const url = `${apiRoot}${request.path}${query ? `?${query}` : ""}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": userAgent,
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${request.token}`,
        },
      });
      const collected: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        collected[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers: collected,
        body: await response.text(),
      };
    },
  };
}
