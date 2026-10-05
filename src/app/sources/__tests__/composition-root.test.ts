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
import { isIso8601DateTime } from "@/core/evidence/timeline";
// Imported statically, not dynamically: the read path under test is the same
// one T7b exercises, and a dynamic import here would make a path typo surface
// as a runtime rejection inside the test rather than a compile error.
import {
  fromCanonicalEventRow,
  toCanonicalEventRow,
} from "../../../../db/canonical-event-mapper";
import type { PluginDescriptor, RegisteredPlugin } from "@/core/plugins/plugin";
import { PluginRegistry } from "@/core/plugins/registry";
import {
  FakeHttpTransport,
  FIXTURE_REPOSITORY,
  fixtureIssue,
  fixtureProposal,
  fullPage,
  pageBody,
} from "@/plugins/github/__tests__/fixtures";

import type {
  CanonicalEventUpsertBuilder,
  CanonicalEventWriter,
  SyncResult,
} from "../index";
import {
  REPOSITORY_ENV_VAR,
  SOURCE_NAME,
  SYNC_FAILURE_CODES,
  SYNC_FAILURE_SCOPES,
  SourceConfigurationError,
  SyncPageRefusedError,
  SyncPersistenceError,
  createSourceRegistry,
  fetchCanonicalEvents,
  getSourceRegistry,
  persistCanonicalEvents,
  requireSource,
  syncSource,
  syncSourceAllPages,
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
 *
 * It RECORDS the conflict clause rather than ignoring it, because the upsert is
 * the behaviour under test: a fake that dropped `onConflictDoUpdate` would let
 * `persistCanonicalEvents` return successfully while production raised 23505,
 * which is exactly the gap this writer now closes. `conflicts` holds the config
 * each persist asked for, so a test can assert the arbiter is the two-column
 * natural key and that `id` is absent from the update set.
 */
class RecordingWriter implements CanonicalEventWriter {
  private readonly batches_: {
    table: unknown;
    rows: Record<string, unknown>[];
  }[] = [];
  private readonly conflicts_: {
    target: unknown;
    set: Record<string, unknown>;
  }[] = [];

  /** Every insert that was attempted, whether or not rows were supplied. */
  get batches(): ReadonlyArray<{
    readonly table: unknown;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
  }> {
    return this.batches_;
  }

  /** Every conflict clause handed to `onConflictDoUpdate`, in call order. */
  get conflicts(): ReadonlyArray<{
    readonly target: unknown;
    readonly set: Record<string, unknown>;
  }> {
    return this.conflicts_;
  }

  get totalRows(): number {
    return this.batches_.reduce((sum, batch) => sum + batch.rows.length, 0);
  }

  /** Every row written, flattened, for order-insensitive assertions. */
  allRows(): Record<string, unknown>[] {
    return this.batches_.flatMap((batch) => batch.rows);
  }

  insert(table: unknown): {
    values(rows: Record<string, unknown>[]): CanonicalEventUpsertBuilder;
  } {
    const batch = { table, rows: [] as Record<string, unknown>[] };
    // Pushed on `insert`, not on `values`, so a target that is handed a table
    // and never written to still shows up as an attempted insert.
    this.batches_.push(batch);
    const conflicts = this.conflicts_;
    return {
      values: (rows: Record<string, unknown>[]) => ({
        onConflictDoUpdate: async (config: {
          target: unknown;
          set: Record<string, unknown>;
        }) => {
          conflicts.push({
            target: config.target,
            set: config.set,
          });
          batch.rows.push(...rows);
          return undefined;
        },
      }),
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

/**
 * Pagination: the defect this block exists for is that a cursor was DROPPED.
 *
 * Before the fix `fetchCanonicalEvents` returned `CanonicalEvent[]` and threw
 * `page.nextCursor` away, and `SyncOptions.cursor` had no producer anywhere in
 * the module. So with `PAGE_SIZE = 30` and descending order, everything older
 * than the newest page was unreachable — not merely awkward, unreachable, and
 * no test could have shown it because no caller could produce a cursor.
 *
 * The plugin issues a cursor only off a FULL page, so these tests pin
 * `pageSize: 2` and serve exactly two items per real page. That is what makes
 * the walk continue: a short page means "exhausted" by the plugin's own
 * documented rule.
 */
describe("composition root: pagination reaches past the first page", () => {
  /** Page 1: issues 1-2 (full → cursor). Page 2: issues 3-4 (full → cursor).
   *  Page 3: empty (short → exhausted). */
  function threePageRegistry(): {
    registry: PluginRegistry;
    transport: FakeHttpTransport;
  } {
    return registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
        "3": { body: "[]" },
      },
      { pageSize: 2 },
    );
  }

  it("returns the next cursor instead of discarding it", async () => {
    const { registry } = threePageRegistry();

    const page = await fetchCanonicalEvents(registry);

    // The defect, stated as an assertion: the cursor survives the mapping.
    // Before the fix this property did not exist on the return value at all.
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
  });

  it("actually fetches the SECOND page by feeding the cursor back in", async () => {
    const { registry } = threePageRegistry();

    const first = await fetchCanonicalEvents(registry);
    expect(first.events.map((e) => e.externalId).sort()).toEqual([
      `${FIXTURE_REPOSITORY}#1`,
      `${FIXTURE_REPOSITORY}#2`,
    ]);

    // The cursor is accepted by the same entry point. This is the assertion that
    // fails if the cursor is dropped: with it dropped there is nothing to pass
    // and the second call can only re-fetch page 1.
    const second = await fetchCanonicalEvents(
      registry,
      SOURCE_NAME,
      first.nextCursor,
    );

    expect(second.events.map((e) => e.externalId).sort()).toEqual([
      `${FIXTURE_REPOSITORY}#3`,
      `${FIXTURE_REPOSITORY}#4`,
    ]);
    // Different content, not the first page again.
    expect(second.events.map((e) => e.id)).not.toEqual(
      first.events.map((e) => e.id),
    );
  });

  it("reports exhaustion by OMITTING nextCursor, not by echoing the input", async () => {
    const { registry } = threePageRegistry();

    const first = await fetchCanonicalEvents(registry);
    const second = await fetchCanonicalEvents(
      registry,
      SOURCE_NAME,
      first.nextCursor,
    );
    expect(second.nextCursor).toBeDefined();

    const third = await fetchCanonicalEvents(
      registry,
      SOURCE_NAME,
      second.nextCursor,
    );

    expect(third.events).toEqual([]);
    // The key property: a caller looping on `nextCursor !== undefined`
    // TERMINATES. Echoing the input cursor back here would loop forever on the
    // empty final page.
    expect(third.nextCursor).toBeUndefined();
  });

  it("syncSource returns the cursor, so its `cursor` option has a producer", async () => {
    const { registry } = threePageRegistry();
    const writer = new RecordingWriter();

    const first: SyncResult = await syncSource({ registry, writer });
    expect(first.events).toHaveLength(2);
    expect(first.persisted).toBe(2);
    expect(first.nextCursor).toBeDefined();

    // The option this whole block exists to make reachable.
    const second = await syncSource({
      registry,
      writer,
      cursor: first.nextCursor,
    });
    expect(second.events.map((e) => e.externalId).sort()).toEqual([
      `${FIXTURE_REPOSITORY}#3`,
      `${FIXTURE_REPOSITORY}#4`,
    ]);
    // Both pages reached the writer: 4 rows, not 2.
    expect(writer.totalRows).toBe(4);
  });

  it("walks every page to exhaustion and sums the result", async () => {
    const { registry } = threePageRegistry();
    const writer = new RecordingWriter();

    const result = await syncSourceAllPages({ registry, writer });

    expect(result.pages).toBe(3);
    // 4 real events across 2 full pages, plus the empty third that proves
    // termination.
    expect(result.events).toHaveLength(4);
    expect(result.events.map((e) => e.externalId).sort()).toEqual([
      `${FIXTURE_REPOSITORY}#1`,
      `${FIXTURE_REPOSITORY}#2`,
      `${FIXTURE_REPOSITORY}#3`,
      `${FIXTURE_REPOSITORY}#4`,
    ]);
    expect(result.persisted).toBe(4);
    expect(writer.totalRows).toBe(4);
    // Exhaustion needs no cursor here: `SyncSourceAllPagesResult` has no
    // `nextCursor` field to be absent, which is the stronger form of the
    // "reports exhaustion by omitting nextCursor" assertion on `syncSource`.
    // Pinned as key absence in "a completed walk's result carries no `failure`
    // and no `nextCursor` key" below.
  });

  it("ABORTS rather than looping forever when a source never reports exhaustion", async () => {
    // A source that keeps handing out cursors is the failure this bound exists
    // for. Every page here is FULL, so the plugin never reports exhaustion and
    // would page indefinitely — which is why the walk needs a bound rather than
    // trusting the source to stop. `maxPages: 3` makes the hang observable in a
    // test instead of freezing the suite.
    const byPage: Record<string, { body: string }> = {};
    for (let page = 1; page <= 10; page += 1) {
      byPage[String(page)] = {
        body: pageBody(fullPage(2, (page - 1) * 2 + 1)),
      };
    }
    const { registry } = registryWith(byPage, { pageSize: 2 });

    await expect(
      syncSourceAllPages({
        registry,
        writer: new RecordingWriter(),
        maxPages: 3,
      }),
    ).rejects.toThrow(/maxPages/);
  });

  it("ABORTS on a repeated cursor instead of paging in circles", async () => {
    // The second way a source fails to advance: a plugin that hands back the
    // SAME cursor over and over is paging itself in circles. Returning quietly
    // would silently re-ingest one page and report a truncated ingest as
    // complete, so the walk aborts on the repeat.
    //
    // A stand-in plugin rather than the real one: the GitHub plugin's cursors
    // advance, so what is under test here is the WALK's reaction to a stuck
    // source, not the plugin's cursor arithmetic (which has its own tests).
    const stuck = new PluginRegistry([
      {
        describe: () => ({
          name: SOURCE_NAME,
          version: "0.1.0",
          requiresAuth: false,
        }),
        fetchItems: async () => ({
          items: fullPage(2, 1),
          nextCursor: "always-the-same",
        }),
        mapToCanonicalEvents: (raw) =>
          raw.map((item) => ({
            id: `stuck:${String((item as { number: unknown }).number)}`,
            source: SOURCE_NAME,
            externalId: String((item as { number: unknown }).number),
            type: "mention" as const,
            title: "stuck",
            occurredAt: "2026-01-01T00:00:00.000Z",
            metadata: {},
          })),
      },
    ]);

    await expect(
      syncSourceAllPages({
        registry: stuck,
        writer: new RecordingWriter(),
      }),
    ).rejects.toThrow(/repeated cursor/);
  });

  it("rejects a nonsensical maxPages rather than defaulting it", async () => {
    const { registry } = threePageRegistry();
    for (const maxPages of [0, -1, 1.5, Number.NaN]) {
      await expect(
        syncSourceAllPages({
          registry,
          writer: new RecordingWriter(),
          maxPages,
        }),
      ).rejects.toThrow(RangeError);
    }
  });
});

/**
 * THE THREE-STATE CONTRACT between `failure` and `nextCursor`, pinned per case.
 *
 * `SyncResult` carries BOTH fields and a reader cannot infer which one wins:
 *   - a REFUSED batch        -> `persisted: 0`, `failure` present, NO cursor;
 *   - a SUCCESS that exhausted the source -> `persisted > 0`, NO failure, NO cursor;
 *   - a SUCCESSFUL PARTIAL   -> `persisted > 0`, NO failure, cursor PRESENT.
 *
 * The refusal case is the one that could silently regress. Pagination adds a
 * second "keep going" signal next to an existing "stop and report" signal, and
 * the natural mistake is to attach the source's cursor to a result whose batch
 * was refused in full — which would tell a caller to advance past a page that
 * was never written, silently losing every event on it. So the refusal path is
 * asserted to carry NO cursor, and the reason is stated in the type.
 */
describe("composition root: failure and nextCursor are independent", () => {
  /**
   * A writer whose persist refuses, standing in for a page-scope CHECK refusal.
   *
   * `refuseAfterCalls` lets a test refuse from the Nth persist onward, so the
   * mid-walk case below is a refusal on a page OTHER than the first. That is the
   * case a single `syncSource` test cannot reach: with one page, the refusal is
   * visible straight to the caller, whereas mid-walk it happens behind pages
   * already written.
   */
  function refusingWriter(refuseAfterCalls = 0): CanonicalEventWriter {
    let calls = 0;
    return {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            calls += 1;
            if (calls > refuseAfterCalls) {
              const cause: unknown = { code: "23514" };
              throw Object.assign(new Error("metadata must be an object"), {
                cause,
              });
            }
            return undefined;
          },
        }),
      }),
    };
  }

  it("a REFUSED batch reports the failure and NO cursor", async () => {
    // Two full pages available, so the SOURCE does hand out a cursor. The
    // refusal must swallow it: nothing was written, so advancing the cursor
    // would skip an unwritten page.
    const { registry } = registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
      },
      { pageSize: 2 },
    );

    const result = await syncSource({ registry, writer: refusingWriter() });

    expect(result.failure).toBeDefined();
    expect(result.persisted).toBe(0);
    // The whole point of this case.
    expect(result.nextCursor).toBeUndefined();
  });

  it("a SUCCESSFUL EXHAUSTED batch reports no failure and no cursor", async () => {
    // A single SHORT page: the source is exhausted immediately, so there is
    // nothing further to point at.
    const { registry } = registryWith(
      { "1": { body: pageBody(fullPage(2, 1)) }, "2": { body: "[]" } },
      { pageSize: 3 },
    );
    const writer = new RecordingWriter();

    const result = await syncSource({ registry, writer });

    expect(result.failure).toBeUndefined();
    expect(result.persisted).toBe(2);
    expect(result.nextCursor).toBeUndefined();
  });

  it("a SUCCESSFUL PARTIAL batch reports no failure and DOES carry a cursor", async () => {
    const { registry } = registryWith(
      { "1": { body: pageBody(fullPage(2, 1)) }, "2": { body: "[]" } },
      { pageSize: 2 },
    );
    const writer = new RecordingWriter();

    const result = await syncSource({ registry, writer });

    expect(result.failure).toBeUndefined();
    expect(result.persisted).toBe(2);
    expect(result.nextCursor).toBeDefined();
  });

  it("a REFUSED page in the MIDDLE of a walk aborts the walk rather than being summed in", async () => {
    // The defect this pins, reproduced rather than described. Page 1 is written;
    // page 2's persist raises a driver-thrown 23514, so `syncSource` REFUSES it
    // (it reports, it does not throw) and returns `{ events: 2, persisted: 0 }`
    // with no cursor. An aggregate that sums `events` and `persisted` without
    // looking at `failure` returns
    //
    //     pages: 2, events.length: 4, persisted: 2, failure: undefined
    //
    // — two events never written, reported as a completed ingest, with nothing on
    // the result to notice. The only defence was a caller happening to compare
    // two fields of a type that documents no such invariant.
    const { registry } = registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
        "3": { body: "[]" },
      },
      { pageSize: 2 },
    );

    // `refuseAfterCalls: 1` — the first persist succeeds, the second refuses.
    const call = syncSourceAllPages({
      registry,
      writer: refusingWriter(1),
    });

    await expect(call).rejects.toBeInstanceOf(SyncPageRefusedError);
    // No aggregate is returned at all, so `persisted === events.length` cannot
    // be violated by a refused page's events leaking into `events`.
    await expect(call).rejects.toThrow(/was refused/);
  });

  it("a MID-WALK refusal names the cursor that fetched it, so the SAME page can be retried", async () => {
    // The refusal is on page 2, which was fetched WITH page 1's `nextCursor`.
    // Re-driving THAT cursor is what retries the refused page; advancing past it
    // would lose those events permanently, since the batch was all-or-nothing
    // and wrote nothing. So the error's `retryCursor` must be the page-1 cursor,
    // not a later one and not undefined.
    const { registry } = registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
        "3": { body: "[]" },
      },
      { pageSize: 2 },
    );

    // What page 1 alone reports, so the retry cursor is checked against the
    // value the walk actually used rather than against a literal.
    const firstPageCursor = await fetchCanonicalEvents(registry).then(
      (page) => page.nextCursor,
    );
    expect(firstPageCursor).toBeDefined();

    const error = await syncSourceAllPages({
      registry,
      writer: refusingWriter(1),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SyncPageRefusedError);
    const refusal = error as SyncPageRefusedError;
    // The classification is carried, not flattened into a message string.
    expect(refusal.failure.code).toBe(SYNC_FAILURE_CODES.eventNotPersistable);
    expect(refusal.failure.scope).toBe(SYNC_FAILURE_SCOPES.page);
    expect(refusal.retryCursor).toBe(firstPageCursor);
    // What survived, stated so a caller knows the walk was not all-or-nothing.
    expect(refusal.pages).toBe(1);
    expect(refusal.persisted).toBe(2);
  });

  it("a refusal on the FIRST page reports `retryCursor: undefined`, not a later cursor", async () => {
    // The degenerate case of the same rule: there was no input cursor, so
    // retrying means re-driving `undefined`. Naming a later cursor here would
    // skip the refused first page — the exact loss this error exists to prevent.
    const { registry } = registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
      },
      { pageSize: 2 },
    );

    const error = await syncSourceAllPages({
      registry,
      writer: refusingWriter(0),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SyncPageRefusedError);
    const refusal = error as SyncPageRefusedError;
    expect(refusal.retryCursor).toBeUndefined();
    expect(refusal.pages).toBe(0);
    expect(refusal.persisted).toBe(0);
  });

  it("a completed walk's result carries no `failure` and no `nextCursor` key", async () => {
    // The fourth shape, pinned. `syncSourceAllPages` reaches exactly ONE of
    // `SyncResult`'s three states — every page written, source exhausted — so
    // the aggregate must not promise the other two. Asserted as key ABSENCE,
    // the stronger fact: a widened `SyncResult & { pages }` type would let a
    // caller branch on a `failure` that can never be there.
    const { registry } = registryWith(
      {
        "1": { body: pageBody(fullPage(2, 1)) },
        "2": { body: pageBody(fullPage(2, 3)) },
        "3": { body: "[]" },
      },
      { pageSize: 2 },
    );

    const result = await syncSourceAllPages({
      registry,
      writer: new RecordingWriter(),
    });

    expect(Object.keys(result).sort()).toEqual([
      "events",
      "pages",
      "persisted",
    ]);
    // The invariant a refused page would have broken.
    expect(result.persisted).toBe(result.events.length);
  });
});

describe("composition root: the credential is resolved, never held", () => {
  it("sends the credential to the transport and keeps it out of every event", async () => {
    const { registry, transport } = registryWith({ "1": { body: TWO_ITEMS } });

    const { events } = await fetchCanonicalEvents(registry);

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

    const { events } = await fetchCanonicalEvents(registry);
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

    expect(once.events.map((e) => e.id)).toEqual(twice.events.map((e) => e.id));
    expect(new Set(once.events.map((e) => e.id)).size).toBe(once.events.length);
  });

  it("persists the same events twice without error, as an upsert", async () => {
    // THE CARD'S CENTRAL CLAIM. A repeated sync of the same source data is the
    // most likely caller behaviour there is, and it must SUCCEED. Before the
    // upsert the second persist raised SQLSTATE 23505 (proven by execution
    // against real Postgres in
    // src/app/sources/__tests__/persist-canonical-events-upsert.test.ts).
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const writer = new RecordingWriter();

    const first = await syncSource({ registry, writer });
    const second = await syncSource({ registry, writer });

    // Neither call throws — asserted by the calls above completing at all.
    expect(first.persisted).toBe(2);
    expect(second.persisted).toBe(2);

    // And the upsert clause was used on BOTH calls, not a plain insert: a plain
    // insert is the exact shape that 235s, so this is what makes "no error"
    // mean "upserted" rather than "the assertion never ran".
    expect(writer.conflicts).toHaveLength(2);
    expect(writer.conflicts[0]).toEqual(writer.conflicts[1]);
  });

  it("targets the natural key (source, externalId) as the conflict arbiter", () => {
    // The specific failure this card exists to close: an arbiter of `id` would
    // leave 23505 in place for every real repeat sync while LOOKING like an
    // idempotency fix. Asserted against the recorded clause, and the column
    // NAMES are read out of the Drizzle column objects rather than compared by
    // identity, so a re-export or a cloned table object cannot pass by accident.
    const writer = new RecordingWriter();

    // No registry here: this asserts the SHAPE of the conflict clause the persist
    // builds, which is independent of where the events came from. The companion
    // test above drives the same clause through a real `syncSource`.
    return persistCanonicalEvents(
      [
        {
          id: "evt_1",
          source: "code_hosting",
          externalId: "ext_1",
          type: "issue",
          title: "t",
          occurredAt: "2026-01-02T03:04:05.000Z",
          metadata: {},
        },
      ],
      writer,
    ).then(() => {
      const conflict = writer.conflicts[0];
      expect(conflict).toBeDefined();

      const target = conflict!.target as { name: string }[];
      expect(target.map((column) => column.name)).toEqual([
        "source",
        "external_id",
      ]);

      // Explicitly NOT the primary key.
      expect(target.map((column) => column.name)).not.toContain("id");

      // The update set is the enumerated mutable columns. `id`, `source` and
      // `externalId` are the key and MUST NOT be rewritten: `id` is the primary
      // key, and reassigning it would orphan anything referencing the row.
      expect(Object.keys(conflict!.set).sort()).toEqual([
        "author",
        "metadata",
        "occurredAt",
        "title",
        "type",
        "url",
      ]);
      expect(Object.keys(conflict!.set)).not.toContain("id");
    });
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

  it("resolves without a database when the page is empty and no writer is given", async () => {
    // Regression pin for the eager-evaluation defect QA found at head ec258c8:
    // `options.writer ?? getDb()` is an ARGUMENT expression, so `getDb()` ran
    // on every syncSource call and threw "DATABASE_URL is not set" even when
    // there was nothing to persist. This asserts the property through
    // syncSource rather than leaving it as prose in a comment, with
    // DATABASE_URL genuinely absent from the environment.
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { registry } = registryWith({ "1": { body: "[]" } });

      const result = await syncSource({ registry });

      expect(result.events).toEqual([]);
      expect(result.persisted).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });
});

describe("composition root: a writer refusal is reported, not thrown", () => {
  /**
   * Sub-millisecond precision on a `timestamptz`: orderable in the domain,
   * unrepresentable on write.
   *
   * MEASURED at this branch's base (`69a79fd`) before any edit, through the REAL
   * `syncSource` path:
   *
   *   isIso8601DateTime("2026-01-02T03:04:05.123456Z") -> true
   *   toCanonicalEventRow(same value) -> TypeError: CanonicalEvent.occurredAt
   *     carries more precision than a Date can hold (3 fractional digits); it
   *     would be silently truncated on write: "2026-01-02T03:04:05.123456Z"
   *   syncSource(...) -> that same TypeError escaping uncaught, 0 rows written
   *
   * The first two are pinned below so the disagreement cannot be "fixed" by
   * quietly narrowing either layer -- this suite asserts the guard's behaviour
   * while BOTH halves still disagree, which is the state the fix must tolerate.
   *
   * WHY A SECOND PLUGIN RATHER THAN A FIXTURE OVERRIDE. This suite lives outside
   * `src/plugins/**`, so it may not name a provider-native field in order to
   * inject one: `plugin-boundary.test.ts` fails the build when it does, and it
   * is right to. The refusal is a property of the `CanonicalEvent` CONTRACT, not
   * of any one source's native shape, so it is driven through a second
   * registered plugin that emits the neutral contract directly. That also makes
   * the point the card cares about: the guard is provider-neutral and holds
   * under a swap.
   */
  const SUB_MILLISECOND = "2026-01-02T03:04:05.123456Z";

  /** The neutral name the second plugin registers under. */
  const SECOND = "ticketing";

  /**
   * A plugin emitting `count` events, the one at position `refuseAt` carrying
   * `occurredAt: SUB_MILLISECOND` and every other a representable instant.
   */
  function pluginWithSubMillisecondAt(
    refuseAt: number,
    count = 1,
  ): RegisteredPlugin {
    const name = SECOND;
    return {
      describe: () => ({ name, version: "0.0.1", requiresAuth: false }),
      fetchItems: async () => ({
        items: Array.from({ length: count }, (_, index) => ({ n: index })),
      }),
      mapToCanonicalEvents: (raw) =>
        raw.map((item) => {
          const index = Number((item as { n?: unknown }).n);
          const at =
            index === refuseAt ? SUB_MILLISECOND : "2026-01-01T00:00:00Z";
          return {
            id: `${name}:${index}`,
            source: name,
            externalId: `${name}-${index}`,
            type: "mention" as const,
            title: `refusal canary ${index}`,
            occurredAt: at,
            metadata: {},
          };
        }),
    };
  }

  /** A registry whose `SECOND` source yields `count` events, one unwritable. */
  function registryRefusing(
    refuseAt: number,
    count = 1,
  ): { registry: PluginRegistry; writer: RecordingWriter } {
    const registry = createSourceRegistry({
      repository: FIXTURE_REPOSITORY,
      transport: new FakeHttpTransport({ byPage: {} }),
      readEnv: fixtureEnv,
      additionalPlugins: [pluginWithSubMillisecondAt(refuseAt, count)],
    });
    return { registry, writer: new RecordingWriter() };
  }

  it("pins the disagreement: the domain accepts what the writer refuses", () => {
    // If this ever goes false, one layer moved and the other is now untested.
    expect(isIso8601DateTime(SUB_MILLISECOND)).toBe(true);
    expect(() =>
      toCanonicalEventRow({
        id: "x",
        source: SOURCE_NAME,
        externalId: "e",
        type: "issue",
        title: "t",
        occurredAt: SUB_MILLISECOND,
        metadata: {},
      }),
    ).toThrow(TypeError);
  });

  it("returns a classified failure instead of letting the TypeError escape", async () => {
    const { registry, writer } = registryRefusing(0);

    const result = await syncSource({ registry, source: SECOND, writer });

    // The specific classified outcome, not merely "did not throw" -- a catch
    // block that swallowed everything would fail here.
    expect(result.failure).toBeDefined();
    expect(result.failure?.code).toBe("event_not_persistable");
    expect(SYNC_FAILURE_CODES.eventNotPersistable).toBe(
      "event_not_persistable",
    );
    // Nothing was written: all-or-nothing, and the count says so.
    expect(result.persisted).toBe(0);
    expect(writer.batches).toHaveLength(0);
    // The fetched events are still returned -- the fetch succeeded, and a
    // caller showing them alongside the refusal is what makes it actionable.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.occurredAt).toBe(SUB_MILLISECOND);
  });

  it("preserves the writer's own rejection message, verbatim", async () => {
    const { registry, writer } = registryRefusing(0);

    const result = await syncSource({ registry, source: SECOND, writer });

    // The writer's job is to know what survives a timestamptz bind, so ITS
    // reason is the reason. Asserted as the exact message the mapper throws --
    // including the offending value -- so the classification cannot quietly
    // become a generic "invalid event" that has swallowed the real cause.
    expect(result.failure?.detail).toBe(
      `CanonicalEvent.occurredAt carries more precision than a Date can hold ` +
        `(3 fractional digits); it would be silently truncated on write: ` +
        JSON.stringify(SUB_MILLISECOND),
    );
    // A caller can therefore see WHY the event was refused, and which one.
    expect(result.failure?.detail).toMatch(/precision than a Date can hold/);
    expect(result.failure?.eventId).toBe(`${SECOND}:0`);
    expect(result.failure?.externalId).toBe(`${SECOND}-0`);
    expect(result.failure?.index).toBe(0);
  });

  it("names the refused event when it is not the only one on the page", async () => {
    // The first two events are writable, the third is not: the classification
    // must carry the RIGHT index and ids, which it cannot do if it reports a
    // blanket page-level failure.
    const { registry, writer } = registryRefusing(2, 3);

    const result = await syncSource({ registry, source: SECOND, writer });

    expect(result.failure?.index).toBe(2);
    expect(result.failure?.eventId).toBe(`${SECOND}:2`);
    expect(result.failure?.externalId).toBe(`${SECOND}-2`);
    expect(result.events).toHaveLength(3);
    // The writable events are NOT persisted: the batch is all-or-nothing, so a
    // partial write could never be reported as a plain success.
    expect(writer.batches).toHaveLength(0);
  });

  it("omits the failure field entirely on a healthy sync", async () => {
    // The happy path must be unchanged, and an always-present `failure:
    // undefined` key would make `if (result.failure)` untestable for callers.
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const writer = new RecordingWriter();

    const result = await syncSource({ registry, writer });

    expect(result.persisted).toBe(2);
    expect(result.failure).toBeUndefined();
    expect(writer.totalRows).toBe(2);
  });

  it("still throws for a credential failure, which has no classification", async () => {
    // The boundary guard is NARROW on purpose. A credential failure has no
    // `SyncFailure` to report, and laundering it into one would be a lie: the
    // events never arrived, so there is no refused event to name.
    const { registry } = registryWith(
      { "1": { body: TWO_ITEMS } },
      { readEnv: () => undefined },
    );
    const writer = new RecordingWriter();

    await expect(syncSource({ registry, writer })).rejects.toThrow(
      /credential/,
    );
  });

  it("throws SyncPersistenceError from a direct persistCanonicalEvents call", async () => {
    // The lower-level function KEEPS throwing, so a caller that bypasses
    // syncSource cannot lose a write silently. It carries the same information
    // the returned failure does.
    const { registry } = registryRefusing(0);
    const { events } = await fetchCanonicalEvents(registry, SECOND);

    let caught: unknown;
    try {
      await persistCanonicalEvents(events, new RecordingWriter());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyncPersistenceError);
    const failure = (caught as SyncPersistenceError).failure;
    expect(failure.code).toBe("event_not_persistable");
    expect(failure.detail).toContain("precision than a Date can hold");
    expect((caught as Error).message).toContain("event_not_persistable");
  });

  it("does not launder a non-TypeError from the writer into a refusal", async () => {
    // Only `TypeError` -- the mapper's own rejection type -- is classified. An
    // Error thrown from inside the mapper's internals is a bug, and must not be
    // reported to the caller as "this event was refused".
    const { registry } = registryWith({ "1": { body: TWO_ITEMS } });
    const { events } = await fetchCanonicalEvents(registry);
    // A writer whose failure is a genuine, unclassified fault.
    //
    // The stub is BOTH a rejected thenable AND an upsert builder, because
    // `CanonicalEventWriter.values`' return type is not fixed across the whole
    // project: the idempotent-upsert work (T16) widens `insert` to hand back a
    // `CanonicalEventUpsertBuilder`, so `values()` stops being the awaited
    // promise and becomes the chained half. A stub written for one of those two
    // shapes does not typecheck against the other -- which is how this suite
    // ended up RED at `tsc` while both commits were individually GREEN. Throwing
    // from every entry point means the assertion holds either way, so the test
    // exercises the behaviour rather than one version of the seam:
    // an error from inside the writer, of a type this module does not classify.
    const brokenWriter: CanonicalEventWriter = {
      insert: () => ({
        values: () => {
          const fail = async (): Promise<never> => {
            throw new RangeError("connection pool exhausted");
          };
          return {
            then: <T1, T2>(
              onFulfilled?: ((value: never) => T1 | PromiseLike<T1>) | null,
              onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
            ): Promise<T1 | T2> => fail().then(onFulfilled, onRejected),
            onConflictDoUpdate: fail,
          };
        },
      }),
    };

    const thrown = await persistCanonicalEvents(events, brokenWriter).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(RangeError);
    // Explicitly NOT classified: a refusal would be an answer about the events,
    // and these events are perfectly writable.
    expect(thrown).not.toBeInstanceOf(SyncPersistenceError);
  });
});

describe("a driver-thrown CHECK violation is a refusal, not an escaped exception", () => {
  /**
   * The neutral name this block's plugin registers under.
   *
   * Local rather than borrowed from the mapper-refusal block above: that
   * constant is scoped inside its own `describe`, and a shared one would couple
   * two independent blocks so that renaming one silently broke the other.
   */
  const SOURCE = "ticketing";

  /**
   * A writer that fails the way the real driver fails.
   *
   * THE SHAPE IS THE POINT, AND IT IS NOT DECORATIVE. Drizzle wraps driver
   * failures, so the SQLSTATE does not sit on the thrown error itself — it sits
   * one or more levels down `cause`. `postgres` puts it there, and this test
   * reproduces that nesting exactly, because a classifier written against a
   * bare `error.code` would pass a flat fixture and then let the real error
   * escape the catch. The walk is asserted against nesting, not against a flat
   * object.
   *
   * The message is a driver-shaped string naming a constraint and quoting the
   * offending value, and it is asserted to be carried VERBATIM into
   * `SyncFailure.detail` — which is where the same information already lands
   * for a mapper rejection. The route is what must never render it.
   */
  function driverCheckViolation(
    message = 'new row for relation "canonical_events" violates check constraint "canonical_events_metadata_is_object_check"',
    code = "23514",
  ): unknown {
    // Two levels of wrapping, exactly as Drizzle-over-postgres produces:
    // Drizzle's own failure outermost, the driver's postgres error beneath it.
    const driverError = Object.assign(new Error(message), { code });
    return Object.assign(
      new Error(`Failed query: insert into "canonical_events" ...`),
      { cause: Object.assign(new Error("wrapped"), { cause: driverError }) },
    );
  }

  /** A writer whose single insert raises `error`. */
  function writerRaising(error: unknown): CanonicalEventWriter {
    return {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async (): Promise<never> => {
            throw error;
          },
        }),
      }),
    };
  }

  /** A registry whose `SOURCE` source yields one writable-looking event. */
  function registryWithOneEvent(): PluginRegistry {
    const name = SOURCE;
    return new PluginRegistry([
      {
        describe: () => ({ name, version: "0.0.1", requiresAuth: false }),
        fetchItems: async () => ({ items: [{ n: 0 }] }),
        mapToCanonicalEvents: () => [
          {
            id: `${name}:0`,
            source: name,
            externalId: `${name}-0`,
            type: "issue" as const,
            title: "check violation canary",
            occurredAt: "2026-01-01T00:00:00Z",
            metadata: {},
          },
        ],
      },
    ]);
  }

  it("returns a classified refusal instead of letting a 23514 escape syncSource", async () => {
    // THE SEAM UNDER TEST. `syncSource` used to `throw` anything that was not
    // a `SyncPersistenceError`, so a database-raised refusal escaped the
    // function entirely and reached the route as an opaque 500. Asserted on the
    // CLASSIFIED OUTCOME rather than on "did not throw", because a catch block
    // that swallowed everything would satisfy the latter.
    const result = await syncSource({
      registry: registryWithOneEvent(),
      source: SOURCE,
      writer: writerRaising(driverCheckViolation()),
    });

    expect(result.failure).toBeDefined();
    // The EXISTING code, not a new outcome: "the batch is not persistable" is
    // the same statement whichever layer said it.
    expect(result.failure?.code).toBe(SYNC_FAILURE_CODES.eventNotPersistable);
    expect(SYNC_FAILURE_CODES.eventNotPersistable).toBe(
      "event_not_persistable",
    );
    // Nothing was written, and the batch is genuinely all-or-nothing.
    expect(result.persisted).toBe(0);
    // The fetched events are still returned: the fetch succeeded and only the
    // write was refused, which is what makes the refusal actionable.
    expect(result.events).toHaveLength(1);
  });

  it("reports PAGE scope and names no event, because the database named none", async () => {
    // A statement-level refusal carries no offending row: the batch is ONE
    // statement, so Postgres names the row it was inserting, not which of
    // several rows tripped the constraint. Fabricating an index here would be a
    // lie in a field callers use to locate the bad event, so the scope says
    // plainly that no single event is identified.
    const result = await syncSource({
      registry: registryWithOneEvent(),
      source: SOURCE,
      writer: writerRaising(driverCheckViolation()),
    });

    expect(result.failure?.scope).toBe(SYNC_FAILURE_SCOPES.page);
    expect(result.failure?.index).toBeUndefined();
    expect(result.failure?.eventId).toBeUndefined();
    expect(result.failure?.externalId).toBeUndefined();
  });

  it("classifies a 23514 from ANY constraint, not just the metadata one", async () => {
    // `canonical_events_type_check` is a different constraint on the same
    // table, and it was equally reachable as a 500. The classifier keys on the
    // SQLSTATE precisely so a constraint nobody enumerated still lands on the
    // refusal path — this is that claim, asserted.
    const result = await syncSource({
      registry: registryWithOneEvent(),
      source: SOURCE,
      writer: writerRaising(
        driverCheckViolation(
          'new row for relation "canonical_events" violates check constraint "canonical_events_type_check"',
        ),
      ),
    });

    expect(result.failure?.code).toBe(SYNC_FAILURE_CODES.eventNotPersistable);
    expect(result.persisted).toBe(0);
  });

  it("carries the driver's own message verbatim, on the same terms as a mapper refusal", async () => {
    const message =
      'new row for relation "canonical_events" violates check constraint "canonical_events_metadata_is_object_check"';

    const result = await syncSource({
      registry: registryWithOneEvent(),
      source: SOURCE,
      writer: writerRaising(driverCheckViolation(message)),
    });

    // The persistence layer's own reason is the reason, including the name of
    // the rule that fired — exactly as `mapRows` preserves the mapper's. The
    // route's job, not this module's, is to never render it.
    expect(result.failure?.detail).toBe(message);
  });

  it("does NOT classify a driver error carrying a different SQLSTATE", async () => {
    // The negative control, and the reason this cannot be "classify anything
    // the writer throws". A unique violation (23505) belongs to the route's
    // `already_present` classification, and an unclassified error must still
    // propagate rather than be laundered into a refusal about the DATA — these
    // events are perfectly writable and saying otherwise would be a lie.
    //
    // Asserted on the OUTERMOST message, which is the one Drizzle throws and the
    // one a caller would see: asserting on the inner driver's text instead would
    // pass for the wrong reason if the wrapper ever swallowed the cause.
    await expect(
      syncSource({
        registry: registryWithOneEvent(),
        source: SOURCE,
        writer: writerRaising(
          driverCheckViolation(
            'duplicate key value violates unique constraint "canonical_events_source_external_id_key"',
            "23505",
          ),
        ),
      }),
    ).rejects.toThrow(/Failed query/);
  });

  it("does NOT classify by message text: 23514 in a message is not a violation", async () => {
    // THE NON-VACUITY OF THE SQLSTATE. If the classifier read the message, this
    // would be reported as a refusal. It must still throw, because a driver
    // message is attacker-influenced data and matching on one would let a
    // caller steer this module's classification with a string.
    await expect(
      syncSource({
        registry: registryWithOneEvent(),
        source: SOURCE,
        writer: writerRaising(
          new Error(
            'connection reset: server said "violates check constraint canonical_events_type_check"',
          ),
        ),
      }),
    ).rejects.toThrow(/connection reset/);
  });

  it("still throws for a non-object cause chain rather than hanging", async () => {
    // `cause` can be anything, including a primitive or a cycle. The walk is
    // depth-bounded for the same reason the route's is: an unbounded walk over a
    // cyclic `cause` would hang the request rather than answer it.
    const cyclic: { message: string; cause?: unknown } = new Error("cyclic");
    cyclic.cause = cyclic;

    await expect(
      syncSource({
        registry: registryWithOneEvent(),
        source: SOURCE,
        writer: writerRaising(cyclic),
      }),
    ).rejects.toThrow(/cyclic/);
  });

  it("keeps the mapper's own per-event refusal at EVENT scope", async () => {
    // The other scope, so `scope` is proven to distinguish rather than merely
    // exist. A mapper rejection DOES name its event, and the two scopes must not
    // be interchangeable: `event` is what tells a caller which event to re-fetch.
    const { registry, writer } = (() => {
      const name = SOURCE;
      return {
        registry: new PluginRegistry([
          {
            describe: () => ({ name, version: "0.0.1", requiresAuth: false }),
            fetchItems: async () => ({ items: [{ n: 0 }] }),
            mapToCanonicalEvents: () => [
              {
                id: `${name}:0`,
                source: name,
                externalId: `${name}-0`,
                type: "issue" as const,
                title: "mapper refusal canary",
                // Sub-millisecond precision: accepted by the domain, refused by
                // the writer's timestamptz bind.
                occurredAt: "2026-01-02T03:04:05.123456Z",
                metadata: {},
              },
            ],
          },
        ]),
        writer: new RecordingWriter(),
      };
    })();

    const result = await syncSource({ registry, source: SOURCE, writer });

    expect(result.failure?.scope).toBe(SYNC_FAILURE_SCOPES.event);
    expect(result.failure?.index).toBe(0);
    expect(result.failure?.eventId).toBe(`${SOURCE}:0`);
    expect(result.failure?.externalId).toBe(`${SOURCE}-0`);
    expect(result.persisted).toBe(0);
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
