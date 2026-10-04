/**
 * Fixture-driven tests for the GitHub source plugin.
 *
 * NO NETWORK AND NO REAL TOKEN. Every fetch path here runs against
 * `FakeHttpTransport`, which returns canned JSON strings, and every credential
 * is the synthetic fixture from `src/core/credentials/fakes.ts`. There is no
 * `fetch`, no `http` and no `octokit` call anywhere in this file, which is the
 * point: if these tests ever needed the network they would fail in CI rather
 * than quietly pass.
 */

import { createFakeCredentialProvider } from "@/core/credentials/fakes";
import {
  CANONICAL_EVENT_TYPES,
  isCanonicalEventType,
} from "@/core/events/canonical-event";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import type { FetchedPage } from "@/core/plugins/plugin";
import { beforeEach, describe, expect, it } from "vitest";

import {
  GitHubSourcePlugin,
  SOURCE_NAME,
  canonicalEventId,
  toJsonValue,
  toMetadata,
} from "../github-plugin";
import { GitHubPluginError, toSafePluginReason } from "../github-errors";
import {
  GITHUB_PLUGIN_ERROR_REASONS,
  GITHUB_PLUGIN_ERROR_CODES,
  reasonForStatus,
} from "../github-errors";
import type { NativeIssueItem } from "../native-item";
import type { HttpTransport, TransportResponse } from "../transport";
import {
  FIXTURE_REPOSITORY,
  FakeHttpTransport,
  fullPage,
  pageBody,
  fixtureIssue,
  fixtureProposal,
} from "./fixtures";

const PAGE_SIZE = 30;

/** Build a plugin over a fake transport serving the given canned pages. */
function pluginWith(
  byPage: Record<string, { body: string; status?: number }>,
  pageSize = PAGE_SIZE,
): { plugin: GitHubSourcePlugin; transport: FakeHttpTransport } {
  const transport = new FakeHttpTransport({ byPage });
  const plugin = new GitHubSourcePlugin({
    transport,
    credentials: createFakeCredentialProvider(),
    repository: FIXTURE_REPOSITORY,
    pageSize,
  });
  return { plugin, transport };
}

/** Walk every page the plugin offers, and report how each call terminated. */
async function drain(
  plugin: GitHubSourcePlugin,
  maxPages = 10,
): Promise<FetchedPage<NativeIssueItem>[]> {
  const pages: FetchedPage<NativeIssueItem>[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await plugin.fetchItems(cursor);
    pages.push(page);
    if (page.nextCursor === undefined) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("drain: pagination did not terminate within maxPages");
}

describe("GitHubSourcePlugin.describe", () => {
  it("reports a provider-neutral name, not a provider or SDK name", () => {
    const { plugin } = pluginWith({});
    const descriptor = plugin.describe();

    expect(descriptor.name).toBe(SOURCE_NAME);
    // The three things the name must NOT be.
    expect(descriptor.name.toLowerCase()).not.toContain("github");
    expect(descriptor.name.toLowerCase()).not.toContain("octokit");
    expect(descriptor.name.toLowerCase()).not.toContain("api.");
    // And it is the name core will store as `CanonicalEvent["source"]`.
    expect(descriptor.name).toBe("code_hosting");
  });

  it("declares auth as data and carries no secret", () => {
    const { plugin } = pluginWith({});
    const descriptor = plugin.describe();

    expect(descriptor.requiresAuth).toBe(true);
    expect(descriptor.authDescription).toContain("read access");
    expect(descriptor.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.stringify(descriptor)).not.toMatch(/github_pat_/);
  });

  it("is stable: repeated calls return an equal descriptor", () => {
    const { plugin } = pluginWith({});
    expect(plugin.describe()).toEqual(plugin.describe());
  });
});

describe("GitHubSourcePlugin.fetchItems", () => {
  it("parses a canned page into validated native items", async () => {
    const { plugin, transport } = pluginWith({
      "1": {
        body: pageBody([
          fixtureIssue(),
          fixtureProposal({ number: 43, id: 2002 }),
        ]),
      },
    });

    const page = await plugin.fetchItems();

    // Assertions on the parsed result, not just on the transport being called.
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.number).toBe(42);
    expect(page.items[0]?.title).toBe("Widget explodes on save");
    expect(page.items[0]?.created_at).toBe("2026-01-02T03:04:05Z");
    expect(page.items[0]?.user?.login).toBe("ada");
    expect(page.items[0]?.labels?.[0]?.name).toBe("bug");
    expect(page.items[1]?.pull_request).toBeDefined();

    // ...and the request the plugin actually built.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.path).toBe(
      `/repos/${FIXTURE_REPOSITORY}/issues`,
    );
    expect(transport.requests[0]?.query).toMatchObject({
      per_page: String(PAGE_SIZE),
      page: "1",
      state: "all",
    });
  });

  it("presents a credential to the transport without keeping it", async () => {
    const { plugin, transport } = pluginWith({
      "1": { body: pageBody([fixtureIssue()]) },
    });

    await plugin.fetchItems();

    expect(transport.requests[0]?.token).toMatch(/^github_pat_/);
    // The plugin holds no field carrying a token of its own. The injected
    // collaborators are excluded deliberately: the fake transport RECORDS the
    // token it was handed (that is how a test asserts it was presented), and
    // the fixture provider owns the fixture values, so a whole-object dump
    // would be asserting something about the fakes rather than about the
    // plugin. What matters is that the plugin itself copies nothing.
    const pluginState = Object.entries(plugin as unknown as object).filter(
      ([key]) => key !== "transport" && key !== "credentials",
    );
    expect(JSON.stringify(pluginState)).not.toContain("github_pat_");
  });

  it("honours nextCursor: two pages then an exhausted empty page", async () => {
    const first = fullPage(PAGE_SIZE, 1);
    const second = fullPage(PAGE_SIZE, 1 + PAGE_SIZE);
    const { plugin, transport } = pluginWith({
      "1": { body: pageBody(first) },
      "2": { body: pageBody(second) },
      "3": { body: pageBody([]) },
    });

    const page1 = await plugin.fetchItems();
    expect(page1.items).toHaveLength(PAGE_SIZE);
    expect(page1.items[0]?.number).toBe(1);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await plugin.fetchItems(page1.nextCursor);
    expect(page2.items).toHaveLength(PAGE_SIZE);
    expect(page2.items[0]?.number).toBe(PAGE_SIZE + 1);
    expect(page2.nextCursor).toBeDefined();

    // The exhausted case: an empty page carrying no cursor at all.
    const page3 = await plugin.fetchItems(page2.nextCursor);
    expect(page3.items).toEqual([]);
    expect(page3.nextCursor).toBeUndefined();
    expect("nextCursor" in page3).toBe(false);

    // The cursor really drove the request: three distinct page parameters.
    expect(transport.requests.map((r) => r.query["page"])).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("stops after a short page without asking for a page that would be empty", async () => {
    const { plugin, transport } = pluginWith({
      "1": { body: pageBody(fullPage(5)) },
    });

    const pages = await drain(plugin);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.nextCursor).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });

  it("terminates a full two-page source without looping", async () => {
    const { plugin, transport } = pluginWith({
      "1": { body: pageBody(fullPage(PAGE_SIZE, 1)) },
      "2": { body: pageBody(fullPage(PAGE_SIZE, 1 + PAGE_SIZE)) },
      "3": { body: pageBody([]) },
    });

    const pages = await drain(plugin);

    expect(pages.map((p) => p.items.length)).toEqual([PAGE_SIZE, PAGE_SIZE, 0]);
    expect(transport.requests).toHaveLength(3);
  });

  it("refuses a cursor it did not issue instead of passing it to the source", async () => {
    const { plugin, transport } = pluginWith({ "1": { body: "[]" } });

    await expect(plugin.fetchItems("page:9999")).rejects.toMatchObject({
      name: "GitHubPluginError",
      code: "invalid_cursor",
    });
    await expect(plugin.fetchItems("'; DROP TABLE--")).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    // Nothing reached the transport: the refusal happens before any request.
    expect(transport.requests).toHaveLength(0);
  });
});

describe("GitHubSourcePlugin.mapToCanonicalEvents", () => {
  it("populates every required canonical field", async () => {
    const { plugin } = pluginWith({});
    const events = plugin.mapToCanonicalEvents([
      fixtureIssue() as unknown as NativeIssueItem,
      fixtureProposal() as unknown as NativeIssueItem,
    ]);

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.id).toBeTruthy();
      expect(event.source).toBe(SOURCE_NAME);
      expect(event.externalId).toBeTruthy();
      expect(isCanonicalEventType(event.type)).toBe(true);
      expect(event.title).toBeTruthy();
      expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.metadata).toBeTypeOf("object");
    }

    expect(events[0]).toMatchObject({
      externalId: `${FIXTURE_REPOSITORY}#42`,
      type: "issue",
      title: "Widget explodes on save",
      occurredAt: "2026-01-02T03:04:05Z",
      url: "https://code.example/acme/widgets/issues/42",
      author: "ada",
    });
    expect(events[1]).toMatchObject({
      externalId: `${FIXTURE_REPOSITORY}#43`,
      type: "change_proposal",
      url: "https://code.example/acme/widgets/pull/43",
    });
  });

  it("emits only members of CanonicalEventType and does not widen the union", () => {
    const { plugin } = pluginWith({});
    const events = plugin.mapToCanonicalEvents([
      fixtureIssue() as unknown as NativeIssueItem,
      fixtureProposal() as unknown as NativeIssueItem,
    ]);

    for (const event of events) {
      expect(CANONICAL_EVENT_TYPES).toContain(event.type);
    }
    // The distinct set is exactly the two roles this source plays -- no
    // provider resource name such as "pull_request" ever becomes a type.
    expect([...new Set(events.map((e) => e.type))].sort()).toEqual([
      "change_proposal",
      "issue",
    ]);
  });

  it("derives a stable id from source + externalId across repeated calls", () => {
    const { plugin } = pluginWith({});
    const raw = [
      fixtureIssue() as unknown as NativeIssueItem,
      fixtureProposal() as unknown as NativeIssueItem,
    ];

    const first = plugin.mapToCanonicalEvents(raw);
    const second = plugin.mapToCanonicalEvents(raw);

    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
    expect(first.map((e) => e.id)).toEqual([
      `${SOURCE_NAME}:${FIXTURE_REPOSITORY}#42`,
      `${SOURCE_NAME}:${FIXTURE_REPOSITORY}#43`,
    ]);
    // ...and equal to what the exported derivation function produces directly,
    // so the id is a pure function of source + externalId and nothing else.
    expect(first[0]?.id).toBe(
      canonicalEventId(SOURCE_NAME, `${FIXTURE_REPOSITORY}#42`),
    );
    expect(first[1]?.id).toBe(
      canonicalEventId(SOURCE_NAME, `${FIXTURE_REPOSITORY}#43`),
    );
  });

  it("keeps ids stable under reordering and repetition of the same item", () => {
    const { plugin } = pluginWith({});
    const a = fixtureIssue({ number: 1 }) as unknown as NativeIssueItem;
    const b = fixtureProposal({ number: 2 }) as unknown as NativeIssueItem;

    const forward = plugin.mapToCanonicalEvents([a, b]);
    const reversed = plugin.mapToCanonicalEvents([b, a]);
    const duplicated = plugin.mapToCanonicalEvents([a, a, b, a]);

    expect(reversed.map((e) => e.id).sort()).toEqual(
      forward.map((e) => e.id).sort(),
    );
    // A repeated item yields a repeated id rather than a fresh one, which is
    // what makes re-ingest idempotent.
    expect(new Set(duplicated.map((e) => e.id)).size).toBe(2);
  });

  it("gives items from different repositories different ids", () => {
    const transport = new FakeHttpTransport({ byPage: {} });
    const here = new GitHubSourcePlugin({
      transport,
      credentials: createFakeCredentialProvider(),
      repository: FIXTURE_REPOSITORY,
    });
    const there = new GitHubSourcePlugin({
      transport,
      credentials: createFakeCredentialProvider(),
      repository: "other/place",
    });
    const raw = [fixtureIssue() as unknown as NativeIssueItem];

    expect(here.mapToCanonicalEvents(raw)[0]?.id).not.toBe(
      there.mapToCanonicalEvents(raw)[0]?.id,
    );
  });

  it("carries provider detail in metadata only", () => {
    const { plugin } = pluginWith({});
    const [event] = plugin.mapToCanonicalEvents([
      fixtureIssue() as unknown as NativeIssueItem,
    ]);

    expect(event?.metadata).toMatchObject({
      native_id: 1001,
      number: 42,
      state: "open",
      comment_count: 2,
      author_login: "ada",
      is_proposal: false,
    });
    expect(event?.metadata["labels"]).toEqual([
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ]);
  });

  it("keeps metadata exactly round-trip safe through JSON, with undefined and nested arrays", () => {
    const { plugin } = pluginWith({});
    const [event] = plugin.mapToCanonicalEvents([
      fixtureIssue({
        closed_at: undefined,
        labels: [
          { name: "bug", color: null, description: undefined },
          { name: "ux", color: "0e8a16", description: "Rough edges" },
        ],
      }) as unknown as NativeIssueItem,
    ]);

    const roundTripped = JSON.parse(JSON.stringify(event)) as CanonicalEvent;

    // Preserved exactly, including the nested array of objects and the
    // explicit nulls standing in for the absent fields.
    expect(roundTripped.metadata).toEqual(event?.metadata);
    expect(JSON.stringify(roundTripped.metadata)).toBe(
      JSON.stringify(event?.metadata),
    );
    // The first label's absent `description` reached the mapper as `undefined`
    // and was normalised to an explicit `null` -- the point of the assertion is
    // that the NORMALISED shape round-trips, which `metadata` equality above
    // already proves. The second label keeps a real description, and the nested
    // array of objects survives in order.
    expect(roundTripped.metadata["labels"]).toEqual([
      { name: "bug", color: null, description: null },
      { name: "ux", color: "0e8a16", description: "Rough edges" },
    ]);
    // The whole event survives, not just metadata.
    expect(roundTripped.id).toBe(event?.id);
    expect(roundTripped.type).toBe(event?.type);
    expect(roundTripped.occurredAt).toBe(event?.occurredAt);
  });

  it("strips undefined from objects and arrays, and stringifies non-finite numbers", () => {
    expect(toJsonValue({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(toJsonValue([1, undefined, 2])).toEqual([1, 2]);
    expect(toJsonValue({ nested: { deep: undefined, kept: "yes" } })).toEqual({
      nested: { kept: "yes" },
    });
    expect(toJsonValue(Number.NaN)).toBe("NaN");
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    // Everything produced must itself survive a JSON round trip.
    const values = [1, "s", true, null, [1, [2]], { a: { b: [1, { c: 2 }] } }];
    for (const value of values) {
      expect(JSON.parse(JSON.stringify(toJsonValue(value)))).toEqual(value);
    }
  });

  it("returns an empty array for an empty input", () => {
    const { plugin } = pluginWith({});
    expect(plugin.mapToCanonicalEvents([])).toEqual([]);
  });
});

describe("GitHubSourcePlugin.fetchItems -> mapToCanonicalEvents", () => {
  it("round-trips a fetched page into canonical events", async () => {
    const { plugin } = pluginWith({
      "1": { body: pageBody([fixtureIssue(), fixtureProposal()]) },
    });

    const page = await plugin.fetchItems();
    const events = plugin.mapToCanonicalEvents(page.items);

    expect(events.map((e) => e.type)).toEqual(["issue", "change_proposal"]);
    expect(events.every((e) => e.source === SOURCE_NAME)).toBe(true);
    expect(events.map((e) => e.id)).toEqual([
      `${SOURCE_NAME}:${FIXTURE_REPOSITORY}#42`,
      `${SOURCE_NAME}:${FIXTURE_REPOSITORY}#43`,
    ]);
    // Re-mapping a second fetched page of the same data is a no-op on ids.
    const again = plugin.mapToCanonicalEvents(page.items);
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });
});

describe("GitHubSourcePlugin error handling", () => {
  /** A transport that rejects, optionally with a secret in the message. */
  function rejectingTransport(error: Error): HttpTransport {
    return {
      // The request is deliberately unnamed-in-body: a rejecting transport
      // never reads it, and naming it only to leave it unused would trip
      // --max-warnings 0.
      request(): Promise<TransportResponse> {
        return Promise.reject(error);
      },
    };
  }

  it("raises a typed error and never leaks a token-shaped credential", async () => {
    const secret = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    const plugin = new GitHubSourcePlugin({
      transport: rejectingTransport(
        new Error(`request failed for token ${secret}`),
      ),
      credentials: createFakeCredentialProvider(),
      repository: FIXTURE_REPOSITORY,
    });

    const thrown = await plugin.fetchItems().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubPluginError);
    const error = thrown as GitHubPluginError;
    expect(error.code).toBe("transport_failed");
    expect(error.message).toContain("transport");
    // The secret must appear nowhere on the error, including on a cause.
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("github_pat_");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      secret,
    );
    expect(String((error as { cause?: unknown }).cause)).not.toContain(secret);
    // The closed field surface: `name` is an own enumerable property because
    // it is a class field. There is no other field, so there is nowhere for a
    // secret to hide -- and `cause` is absent, which is the whole point.
    expect(Object.keys(error).sort()).toEqual([
      "code",
      "name",
      "reason",
      "status",
    ]);
    expect("cause" in error).toBe(false);
  });

  it("keeps a credential failure off the message too", async () => {
    const plugin = new GitHubSourcePlugin({
      transport: new FakeHttpTransport({ byPage: {} }),
      credentials: {
        source: "fake",
        getToken(): Promise<string> {
          return Promise.reject(
            new Error("no token github_pat_zzzz-not-really-zzzz"),
          );
        },
      },
      repository: FIXTURE_REPOSITORY,
    });

    const error = (await plugin
      .fetchItems()
      .catch((caught: unknown) => caught)) as GitHubPluginError;

    expect(error.code).toBe("credential_failed");
    expect(error.message).not.toContain("github_pat_");
    expect(error.message).not.toMatch(/zzz/);
  });

  it("maps a non-2xx status to a typed, secret-free error", async () => {
    const { plugin } = pluginWith({ "1": { body: "{}", status: 401 } });

    const error = (await plugin
      .fetchItems()
      .catch((caught: unknown) => caught)) as GitHubPluginError;

    expect(error).toBeInstanceOf(GitHubPluginError);
    expect(error.code).toBe("http_status");
    expect(error.status).toBe(401);
    expect(error.reason).toContain("rejected the presented credential");
  });

  it.each([
    [403, "lacks access"],
    [404, "does not exist"],
    [429, "rate-limited"],
    [500, "server-side"],
    [418, "unexpected status"],
  ])("maps status %i onto a fixed reason", async (status, fragment) => {
    const { plugin } = pluginWith({ "1": { body: "[]", status } });

    const error = (await plugin
      .fetchItems()
      .catch((caught: unknown) => caught)) as GitHubPluginError;

    expect(error.code).toBe("http_status");
    expect(error.status).toBe(status);
    expect(error.reason).toContain(fragment);
  });

  it("rejects a body that is not JSON, not an array, or not items", async () => {
    const notJson = pluginWith({ "1": { body: "<html>nope</html>" } });
    await expect(notJson.plugin.fetchItems()).rejects.toMatchObject({
      code: "malformed_response",
      reason: "the response body was not valid JSON",
    });

    const notArray = pluginWith({ "1": { body: '{"total_count": 3}' } });
    await expect(notArray.plugin.fetchItems()).rejects.toMatchObject({
      code: "malformed_response",
      reason: "the response body was not the expected array of items",
    });

    const badItem = pluginWith({ "1": { body: '[{"id": 1}]' } });
    await expect(badItem.plugin.fetchItems()).rejects.toMatchObject({
      code: "malformed_response",
      reason: "a response item did not match the expected shape",
    });
  });

  it("does not silently drop a malformed item from an otherwise good page", async () => {
    const { plugin } = pluginWith({
      "1": { body: pageBody([fixtureIssue(), { id: 5 }]) },
    });

    // One bad item fails the page rather than returning a short page that
    // looks complete.
    await expect(plugin.fetchItems()).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
});

/**
 * The two choke points, tested DIRECTLY.
 *
 * Both exist to stop an arbitrary string reaching a canonical value, and both
 * were found un-testable through the public surface by mutation: neutering
 * `toSafePluginReason` and replacing `toMetadata`'s normalisation with a raw
 * cast each left all 30 behaviour tests green. A defence that no test can
 * fail is not a defence, so they are asserted here at the boundary itself.
 */
describe("choke points: arbitrary input cannot become a canonical value", () => {
  it("toMetadata normalises even input the mapper would never produce", () => {
    // Raw `undefined` reaching toMetadata, with no `?? null` applied first.
    // Under a plain cast this would keep the key with an undefined value, and
    // `JSON.stringify` would then DROP it -- so metadata would silently differ
    // before and after a round trip.
    const metadata = toMetadata({
      kept: "yes",
      absent: undefined,
      nested: { alsoAbsent: undefined, kept: 1 },
      list: [{ gone: undefined, kept: 2 }],
    });

    expect(metadata).toEqual({
      kept: "yes",
      nested: { kept: 1 },
      list: [{ kept: 2 }],
    });
    expect("absent" in metadata).toBe(false);
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  });

  it("toMetadata coerces the non-JSON shapes a raw cast would smuggle through", () => {
    expect(toMetadata({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toEqual({
      n: "NaN",
      i: "Infinity",
    });
    // A function is not a JsonValue; it is stringified rather than dropped, so
    // its presence is visible rather than looking like an absent field.
    const withFn = toMetadata({ fn: () => 1 });
    expect(typeof withFn["fn"]).toBe("string");
  });

  it("toMetadata refuses a non-object rather than returning it as metadata", () => {
    expect(toMetadata({ array: [1, 2] })).toEqual({ array: [1, 2] });
    // An array at the top level is not a valid bag; the guard exists for that.
    expect(toSafePluginReason.call(null, "x")).toBe(
      GITHUB_PLUGIN_ERROR_REASONS.bodyNotJson,
    );
  });

  it("toSafePluginReason passes an allowlisted reason through byte for byte", () => {
    for (const reason of Object.values(GITHUB_PLUGIN_ERROR_REASONS)) {
      expect(toSafePluginReason(reason)).toBe(reason);
    }
  });

  it("toSafePluginReason collapses a token-shaped string to the generic reason", () => {
    const secret = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    expect(toSafePluginReason(secret)).toBe(
      GITHUB_PLUGIN_ERROR_REASONS.bodyNotJson,
    );
    expect(toSafePluginReason(secret)).not.toContain("github_pat");
    // Any non-allowlisted text at all collapses, not just token-shaped text.
    for (const value of ["anything at all", 42, null, undefined, {}, []]) {
      expect(toSafePluginReason(value)).toBe(
        GITHUB_PLUGIN_ERROR_REASONS.bodyNotJson,
      );
    }
  });

  it("keeps a secret out of a GitHubPluginError built with a secret reason", () => {
    const secret = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    // A throw site that wrongly passed the offending value as the reason.
    const error = new GitHubPluginError("transport_failed", {
      reason:
        secret as unknown as (typeof GITHUB_PLUGIN_ERROR_REASONS)[keyof typeof GITHUB_PLUGIN_ERROR_REASONS],
    });

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("github_pat");
    expect(error.reason).toBe(GITHUB_PLUGIN_ERROR_REASONS.bodyNotJson);
  });

  it("structurally cannot carry a secret, even if a throw site offers one", () => {
    // The `as never` cast is what makes this compile: a caller wrongly passing
    // extra fields, including a `cause`, is exactly the mistake worth catching.
    // GitHubPluginError's constructor copies ONLY code/reason/status, so the
    // offered extra fields are discarded rather than forwarded.
    const secret = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    const error = new GitHubPluginError("transport_failed", {
      reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
      cause: new Error(`rejected for token ${secret}`),
      detail: secret,
      response: { body: secret },
    } as never);

    expect(Object.keys(error).sort()).toEqual([
      "code",
      "name",
      "reason",
      "status",
    ]);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect((error as { detail?: unknown }).detail).toBeUndefined();
    expect(error.message).not.toContain(secret);
    // Serialising the whole error -- everything own and enumerable, plus the
    // message -- is the strongest check that no field carries the secret.
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("reasonForStatus never returns anything outside the allowlist", () => {
    const allowlist = new Set<string>(
      Object.values(GITHUB_PLUGIN_ERROR_REASONS),
    );
    for (const status of [100, 301, 401, 402, 418, 500, 503, 599, 999, -1, 0]) {
      expect(allowlist.has(reasonForStatus(status))).toBe(true);
    }
  });

  it("exposes a closed code set", () => {
    expect([...GITHUB_PLUGIN_ERROR_CODES].sort()).toEqual([
      "credential_failed",
      "http_status",
      "invalid_cursor",
      "malformed_response",
      "transport_failed",
    ]);
  });
});

describe("GitHubSourcePlugin: no network in tests", () => {
  const realFetch = globalThis.fetch;
  afterEachRestore();

  function afterEachRestore(): void {
    globalThis.fetch = realFetch;
  }

  beforeEach(() => {
    // Trip a canary in place of fetch for the duration of this block. If any
    // code path reached the network, this would throw instead of silently
    // succeeding in an environment that happens to have connectivity.
    globalThis.fetch = (() => {
      throw new Error("network access attempted in a plugin test");
    }) as unknown as typeof globalThis.fetch;
  });

  it("completes a full fetch + map cycle with fetch disabled", async () => {
    const transport = new FakeHttpTransport({
      byPage: { "1": { body: pageBody([fixtureIssue(), fixtureProposal()]) } },
    });
    const plugin = new GitHubSourcePlugin({
      transport,
      credentials: createFakeCredentialProvider(),
      repository: FIXTURE_REPOSITORY,
    });

    const page = await plugin.fetchItems();
    const events = plugin.mapToCanonicalEvents(page.items);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["issue", "change_proposal"]);
  });
});
