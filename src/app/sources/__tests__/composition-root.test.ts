/**
 * T11: the composition root wires the GitHub plugin, and what it fetches is
 * persisted.
 *
 * NO NETWORK AND NO REAL TOKEN. Every fetch path runs against the
 * `FakeHttpTransport` seam from `src/plugins/github/__tests__/fixtures.ts`, and
 * the credential is reached through the PRODUCTION credential source (`env`),
 * fed by an injected `readEnv`. No test-only credential source is reachable
 * from the composition root by construction, so these tests exercise the same
 * wiring production uses rather than a parallel one.
 *
 * WHAT MAKES THESE TESTS NON-VACUOUS. Every assertion below is written so that
 * it fails if the plugin stops being wired. The card requires two mutations to
 * be proven RED rather than argued about:
 *   (i)  stubbing the mapper to return `[]` breaks the persistence assertion;
 *   (ii) deleting the persistence call breaks the round-trip assertion.
 * Both were applied and observed failing; see the card comment.
 *
 * The persistence target is a structural fake recording the rows it was handed,
 * so no Postgres is needed for `bun run test` and the assertion is on the exact
 * rows that WOULD be written. The real-database round trip is proved separately
 * by T7b's `db/__tests__/canonical-events-persistence.test.ts`; what this file
 * adds is the wiring between the two, which no existing test covered.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "@/core/events/canonical-event";
// Imported statically, not dynamically: the read path under test is the same
// one T7b exercises, and a dynamic import here would make a path typo surface
// as a runtime rejection inside the test rather than a compile error.
import {
  fromCanonicalEventRow,
  toCanonicalEventRow,
} from "../../../../db/canonical-event-mapper";
import type { PluginDescriptor } from "@/core/plugins/plugin";
import { PluginRegistry } from "@/core/plugins/registry";
import {
  FakeHttpTransport,
  FIXTURE_REPOSITORY,
  fixtureIssue,
  fixtureProposal,
  pageBody,
} from "@/plugins/github/__tests__/fixtures";

import type { CanonicalEventWriter, SyncResult } from "../index";
import {
  REPOSITORY_ENV_VAR,
  SOURCE_NAME,
  SourceConfigurationError,
  createSourceRegistry,
  fetchCanonicalEvents,
  getSourceRegistry,
  persistCanonicalEvents,
  requireSource,
  syncSource,
} from "../index";

/**
 * The synthetic token the injected `readEnv` serves. It is the fixture value
 * already used across this repo's tests — hyphenated English prose, no
 * alphanumeric run — and it is served through `readEnv` rather than assigned to
 * a module-level "token" so there is no token-shaped constant in this file that
 * a later reader might mistake for configuration.
 */
const FIXTURE_PAT = "github_pat_-not-a-real-fixture-token-1";

/** Reads the fixture token, ignoring the real environment entirely. */
const fixtureEnv = (): string | undefined => FIXTURE_PAT;

/** One page of two distinct fixture items: an issue and a change proposal. */
const TWO_ITEMS = pageBody([fixtureIssue(), fixtureProposal()]);

/**
 * A third distinct item, so the idempotency assertion below is testing three
 * distinct events rather than the same one twice: `fixtureIssue()` twice would
 * carry the same `number`, so `externalId` would repeat and the unique-id
 * assertion would pass for the wrong reason.
 */
const THREE_ITEMS = pageBody([
  fixtureIssue(),
  fixtureProposal(),
  fixtureIssue({ number: 44, id: 1003, title: "Widget drifts on load" }),
]);

/**
 * A recording persistence target.
 *
 * Structured exactly to {@link CanonicalEventWriter}, so a change to that
 * interface breaks this file at compile time rather than silently accepting a
 * target that persists nothing.
 */
class RecordingWriter implements CanonicalEventWriter {
  private readonly batches_: {
    table: unknown;
    rows: Record<string, unknown>[];
  }[] = [];

  /** Every insert that was attempted, whether or not rows were supplied. */
  get batches(): ReadonlyArray<{
    readonly table: unknown;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
  }> {
    return this.batches_;
  }

  get totalRows(): number {
    return this.batches_.reduce((sum, batch) => sum + batch.rows.length, 0);
  }

  /** Every row written, flattened, for order-insensitive assertions. */
  allRows(): Record<string, unknown>[] {
    return this.batches_.flatMap((batch) => batch.rows);
  }

  insert(table: unknown): {
    values(rows: Record<string, unknown>[]): PromiseLike<unknown>;
  } {
    const batch = { table, rows: [] as Record<string, unknown>[] };
    // Pushed on `insert`, not on `values`, so a target that is handed a table
    // and never written to still shows up as an attempted insert.
    this.batches_.push(batch);
    return {
      values: async (rows: Record<string, unknown>[]) => {
        batch.rows.push(...rows);
        return undefined;
      },
    };
  }
}

/** A registry over the GitHub plugin with a fake transport serving `byPage`. */
function registryWith(
  byPage: Record<string, { body: string }>,
  overrides: Record<string, unknown> = {},
): { registry: PluginRegistry; transport: FakeHttpTransport } {
  const transport = new FakeHttpTransport({ byPage });
  const registry = createSourceRegistry({
    repository: FIXTURE_REPOSITORY,
    transport,
    readEnv: fixtureEnv,
    ...overrides,
  });
  return { registry, transport };
}

/** A second, minimal plugin, to prove the registry accepts more than one entry. */
function secondPlugin(name: string): {
  describe(): PluginDescriptor;
  fetchItems(cursor?: string): Promise<{ items: readonly unknown[] }>;
  mapToCanonicalEvents(raw: readonly unknown[]): CanonicalEvent[];
} {
  return {
    describe: () => ({
      name,
      version: "0.0.1",
      requiresAuth: false,
    }),
    fetchItems: async () => ({ items: [] }),
    mapToCanonicalEvents: (raw) =>
      raw.map((item) => ({
        id: `${name}:${String((item as { n: unknown }).n)}`,
        source: name,
        externalId: String((item as { n: unknown }).n),
        type: "mention" as const,
        title: "second",
        occurredAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      })),
  };
}

describe("composition root: the registry holds the wired GitHub plugin", () => {
  it("registers the GitHub plugin under its own provider-neutral name", () => {
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });

    // NOT "github": the name is the ROLE, so it survives a provider swap. See
    // the plugin's own header for why.
    expect(SOURCE_NAME).toBe("code_hosting");
    expect(registry.names()).toEqual([SOURCE_NAME]);
    expect(registry.has(SOURCE_NAME)).toBe(true);

    const resolved = requireSource(registry, SOURCE_NAME);
    expect(resolved.describe().version).toBe("0.1.0");
    expect(resolved.describe().requiresAuth).toBe(true);
  });

  it("resolves the plugin through the registry, not by importing it directly", () => {
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });

    // `requireSource` is the accessor callers use; an unknown name is a fixed
    // reason, never the caller's text echoed back.
    expect(() => requireSource(registry, "not_registered")).toThrow(
      SourceConfigurationError,
    );
    expect(() => requireSource(registry, "not_registered")).toThrow(
      /not registered/,
    );
  });

  it("registers additional already-constructed plugins alongside it", () => {
    const { registry } = registryWith(
      { "1": { body: TWO_ITEMS } },
      { additionalPlugins: [secondPlugin("ticketing")] },
    );

    expect(registry.size).toBe(2);
    expect(registry.names()).toEqual([SOURCE_NAME, "ticketing"]);
    expect(requireSource(registry, "ticketing").describe().name).toBe(
      "ticketing",
    );
  });

  it("refuses to build a transport with no HTTP implementation available", () => {
    const original = globalThis.fetch;
    // @ts-expect-error deliberately removing the runtime capability
    delete globalThis.fetch;
    try {
      expect(() =>
        createSourceRegistry({ repository: FIXTURE_REPOSITORY }),
      ).toThrow(SourceConfigurationError);
      expect(() =>
        createSourceRegistry({ repository: FIXTURE_REPOSITORY }),
      ).toThrow(/no HTTP transport/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("composition root: the credential is resolved, never held", () => {
  it("sends the credential to the transport and keeps it out of every event", async () => {
    const { registry, transport } = registryWith({ "1": { body: TWO_ITEMS } });

    const events = await fetchCanonicalEvents(registry);

    // The plugin asked the injected provider, which asked `readEnv`. Proven by
    // the token arriving at the transport — the ONLY place it may appear.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.token).toBe(FIXTURE_PAT);

    // And nowhere else: not in the mapped events, not in their JSON form.
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(FIXTURE_PAT);
    expect(serialised).not.toContain("github_pat_");
  });

  it("does not read the real environment when a reader is injected", async () => {
    // No `process.env` mutation: `readEnv` is the only reader the composition
    // root hands the credential provider, so the real variable is not consulted
    // and no real token can exist in this test.
    const { registry, transport } = registryWith({ "1": { body: TWO_ITEMS } });
    await fetchCanonicalEvents(registry);
    expect(transport.requests[0]?.token).toBe(FIXTURE_PAT);
    expect(REPOSITORY_ENV_VAR).toBe("DEVLOOP_REPOSITORY");
  });

  it("surfaces an absent credential as the plugin's typed, secret-free error", async () => {
    const { registry } = registryWith(
      { "1": { body: TWO_ITEMS } },
      { readEnv: () => undefined },
    );

    // No token is present at all, so the provider fails. The plugin converts any
    // credential failure into its own typed error whose reason is a fixed string
    // — and this is the composition root's promise: the failure crosses this
    // module without a token ever existing to leak.
    await expect(fetchCanonicalEvents(registry)).rejects.toThrow(/credential/);
  });
});

describe("composition root: fetched events persist through the Drizzle client", () => {
  it("writes one row per canonical event, with only contract-defined fields", async () => {
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const writer = new RecordingWriter();

    const events = await fetchCanonicalEvents(registry);
    const persisted = await persistCanonicalEvents(events, writer);

    expect(events).toHaveLength(2);
    expect(persisted).toBe(2);
    expect(writer.totalRows).toBe(2);
    expect(writer.batches).toHaveLength(1);
    // One insert against the canonical_events table, not N.
    expect(writer.batches[0]?.rows).toHaveLength(2);

    const row = writer.allRows()[0]!;
    // Exactly the CanonicalEvent fields the schema defines — asserted as a key
    // SET so an invented column fails here rather than at the database.
    expect(Object.keys(row).sort()).toEqual([
      "author",
      "externalId",
      "id",
      "metadata",
      "occurredAt",
      "source",
      "title",
      "type",
      "url",
    ]);
    expect(row.source).toBe(SOURCE_NAME);
    expect(row.type).toBe("issue");
    expect(row.externalId).toBe(`${FIXTURE_REPOSITORY}#42`);
    expect(row.id).toBe(`${SOURCE_NAME}:${FIXTURE_REPOSITORY}#42`);
    // occurredAt is parsed to a Date for timestamptz; the string form is the
    // contract's.
    expect((row.occurredAt as Date).toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("maps the change proposal in the same page to the change_proposal role", async () => {
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const writer = new RecordingWriter();

    await syncSource({ registry, writer });

    const types = writer.allRows().map((row) => row.type);
    expect(types).toEqual(["issue", "change_proposal"]);
    // Metadata stays on the plugin side of the boundary: a JSON bag, never a
    // named column.
    const metadata = writer.allRows()[0]!.metadata as Record<string, unknown>;
    expect(metadata.number).toBe(42);
    expect(metadata.is_proposal).toBe(false);
  });

  it("round-trips the fetched event back to the contract shape", async () => {
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const writer = new RecordingWriter();

    const result: SyncResult = await syncSource({ registry, writer });
    expect(result.persisted).toBe(2);

    // A read path reconstructed from the recorded rows, using the SAME mapper
    // the real read path uses. This is what fails if persistence is skipped:
    // `writer.allRows()` is empty and the reconstructed event is not the one
    // that was fetched.
    const [written] = writer.allRows();
    expect(written).toBeDefined();

    const read = fromCanonicalEventRow({
      ...written,
      occurredAt: written!.occurredAt as Date,
    } as Parameters<typeof fromCanonicalEventRow>[0]);

    // The ONE field that is not byte-identical on the way back, pinned rather
    // than hidden: `occurredAt` is an ISO-8601 string on the contract and a
    // `timestamptz` in the column, so `toISOString()` always renders UTC with
    // millisecond precision. The fixture's `...:05Z` comes back `...:05.000Z`.
    // T7b pins the same normalisation for the real database.
    const fetched = JSON.parse(JSON.stringify(result.events[0]));
    expect(read.occurredAt).toBe("2026-01-02T03:04:05.000Z");
    expect(fetched.occurredAt).toBe("2026-01-02T03:04:05Z");

    // Every OTHER field deep-equals, and re-writing the normalised value is
    // stable — so a second pass through the same round trip is byte-identical.
    expect({ ...read, occurredAt: fetched.occurredAt }).toEqual(fetched);
    expect(toCanonicalEventRow(read).occurredAt.toISOString()).toBe(
      read.occurredAt,
    );
  });

  it("reports a short page as exhausted and stops", async () => {
    // Two items in a page of two is FULL, so the plugin hands out a cursor; a
    // page shorter than the size is the last page. Both are asserted so the
    // wiring cannot quietly swallow pagination state.
    const { registry } = registryWith(
      { "1": { body: TWO_ITEMS }, "2": { body: "[]" } },
      { pageSize: 2 },
    );
    const plugin = requireSource(registry, SOURCE_NAME);

    const first = await plugin.fetchItems();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await plugin.fetchItems(first.nextCursor);
    expect(second.items).toHaveLength(0);
    expect(second.nextCursor).toBeUndefined();
  });

  it("is idempotent on the same page: the canonical id is stable", async () => {
    const { registry } = registryWith({ "1": { body: THREE_ITEMS } });

    const once = await fetchCanonicalEvents(registry);
    const twice = await fetchCanonicalEvents(registry);

    expect(once.map((e) => e.id)).toEqual(twice.map((e) => e.id));
    expect(new Set(once.map((e) => e.id)).size).toBe(once.length);
  });

  it("writes nothing, and does not touch the database, for an empty page", async () => {
    const { registry } = registryWith({ "1": { body: "[]" } });
    const writer = new RecordingWriter();

    const result = await syncSource({ registry, writer });

    expect(result.events).toEqual([]);
    expect(result.persisted).toBe(0);
    // No insert at all: an empty `values()` is both a wasted round trip and a
    // Drizzle error.
    expect(writer.batches).toHaveLength(0);
  });
});

describe("composition root: configuration errors", () => {
  const originalRepository = process.env[REPOSITORY_ENV_VAR];

  afterEach(() => {
    if (originalRepository === undefined) {
      delete process.env[REPOSITORY_ENV_VAR];
    } else {
      process.env[REPOSITORY_ENV_VAR] = originalRepository;
    }
  });

  it("names the variable when no repository is configured", () => {
    delete process.env[REPOSITORY_ENV_VAR];
    expect(() => getSourceRegistry()).toThrow(SourceConfigurationError);
    expect(() => getSourceRegistry()).toThrow(REPOSITORY_ENV_VAR);
  });

  it("treats an empty repository as unset", () => {
    process.env[REPOSITORY_ENV_VAR] = "";
    expect(() => getSourceRegistry()).toThrow(/is not set/);
  });

  it("memoises the process-wide registry", () => {
    process.env[REPOSITORY_ENV_VAR] = FIXTURE_REPOSITORY;
    // A transport is injected only via `options`, which bypasses the memo; the
    // memoised path is the one that must return the SAME instance.
    const first = getSourceRegistry();
    const second = getSourceRegistry();
    expect(second).toBe(first);
    expect(second.names()).toEqual([SOURCE_NAME]);
  });
});
