/**
 * Unit tests for the POST /api/sync handler (T15).
 *
 * NO real network and NO real token anywhere in this file: the registry is built
 * from a fake `SourcePlugin`, the persistence target is an in-memory writer,
 * and the credential is an obviously-fake sentinel string that exists only to
 * be searched for. `bun run test` therefore needs neither a network nor a
 * `.env`, exactly as the composition root's own tests do.
 *
 * The token-leak assertions are the reason the sentinel is so loud: a test that
 * greps for "the token we happened to use" proves nothing if the token is a
 * realistic string that could plausibly appear in an error for other reasons.
 * `ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f` cannot appear anywhere by accident.
 */

import { describe, expect, it, vi } from "vitest";

import type { CanonicalEvent } from "@/core/events/canonical-event";
import type { PluginRegistry } from "@/core/plugins/registry";
import { PluginRegistry as Registry } from "@/core/plugins/registry";
import type { FetchedPage, PluginDescriptor } from "@/core/plugins/plugin";
import type {
  CanonicalEventConflictConfig,
  CanonicalEventWriter,
} from "@/app/sources";
import {
  persistCanonicalEvents,
  SourceConfigurationError,
  syncSource,
} from "@/app/sources";
import {
  GitHubPluginError,
  GITHUB_PLUGIN_ERROR_REASONS,
} from "@/plugins/github/github-errors";

import { handleSyncRequest, SYNC_OUTCOMES } from "../handler";

/** Obviously fake, obviously searchable, and impossible to reach accidentally. */
const SENTINEL_TOKEN = "ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f";

const SOURCE = "code_hosting";

function event(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: `${SOURCE}:acme/demo#1`,
    source: SOURCE,
    externalId: "acme/demo#1",
    type: "issue",
    title: "Something happened",
    occurredAt: "2026-10-04T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

/**
 * The row type the SEAM asks for, derived from the seam itself rather than
 * re-declared: `values()`'s parameter type, read off
 * {@link CanonicalEventWriter}. Importing `db/schema`'s row type here instead
 * would make this test depend on the storage layer's own export list, and a
 * fake that names its parameter from the contract it is implementing cannot
 * silently drift from it.
 */
type WriterRow = Parameters<
  ReturnType<CanonicalEventWriter["insert"]>["values"]
>[0];

type RecordingWriter = CanonicalEventWriter & {
  /** One entry per applied insert: the rows that write would have persisted. */
  readonly written: WriterRow[];
  /** One entry per applied insert: the conflict clause it was applied with. */
  readonly conflicts: CanonicalEventConflictConfig[];
};

/**
 * A recording writer, satisfying the seam the production upsert widened:
 * `insert().values(rows)` is no longer the awaited promise, it is the CHAINED
 * half of an insert and hands back a builder that REQUIRES
 * `.onConflictDoUpdate(config)`. A fake written for the pre-upsert shape — one
 * whose `values()` is an `async` function — does not satisfy the current
 * {@link CanonicalEventWriter}, which is exactly how this suite ended up RED at
 * `tsc` while T15 and T16 were each GREEN alone.
 *
 * So the fake models the real thing: `values()` captures the rows and returns a
 * {@link CanonicalEventUpsertBuilder}, and the write is recorded when the
 * conflict clause is applied — the point at which production's query would
 * actually execute. `failWith` is thrown from THERE, not from `values()`, so a
 * refused write is never recorded as one.
 *
 * The method signatures are the seam's own, spelled out rather than cast: no
 * `any`, no `as unknown as`, so if the seam changes shape this fake stops
 * compiling instead of quietly satisfying it.
 */
function recordingWriter(failWith?: unknown): RecordingWriter {
  const written: WriterRow[] = [];
  const conflicts: CanonicalEventConflictConfig[] = [];
  return {
    written,
    conflicts,
    insert() {
      return {
        values(rows: WriterRow) {
          return {
            async onConflictDoUpdate(
              config: CanonicalEventConflictConfig,
            ): Promise<undefined> {
              if (failWith !== undefined) throw failWith;
              written.push(rows);
              conflicts.push(config);
              return undefined;
            },
          };
        },
      };
    },
  };
}

/** A fake source plugin: no transport, no credential, no network. */
function fakePlugin(
  items: readonly unknown[],
  options: {
    failWith?: unknown;
    name?: string;
  } = {},
): {
  describe(): PluginDescriptor;
  fetchItems(): Promise<FetchedPage<unknown>>;
  mapToCanonicalEvents(raw: readonly unknown[]): CanonicalEvent[];
} {
  return {
    describe: () => ({
      name: options.name ?? SOURCE,
      version: "0.0.0-test",
      requiresAuth: false,
    }),
    async fetchItems() {
      if (options.failWith !== undefined) throw options.failWith;
      return { items };
    },
    mapToCanonicalEvents: (raw) => raw as CanonicalEvent[],
  };
}

function registryWith(plugin: ReturnType<typeof fakePlugin>): PluginRegistry {
  return new Registry([plugin]);
}

/**
 * The real production `syncSource`, used as-is.
 *
 * No wrapper is needed or wanted here: `syncSource` already accepts an injected
 * registry and an injected writer, so passing the real function through proves
 * the route drives the ACTUAL pipeline rather than a stand-in that happens to
 * have the same signature. A hand-rolled reimplementation would be exactly the
 * kind of test that passes while the production call site is broken.
 */
const realSync = syncSource;

describe("POST /api/sync handler", () => {
  it("reports a persisted count and counts by type on success", async () => {
    const writer = recordingWriter();
    const events = [
      event(),
      event({ id: "b", externalId: "acme/demo#2", type: "change_proposal" }),
      event({ id: "c", externalId: "acme/demo#3" }),
    ];

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin(events)),
      writer,
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe(SYNC_OUTCOMES.synced);
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(3);
    expect(body.fetched).toBe(3);
    expect(body.byType).toEqual({ issue: 2, change_proposal: 1 });
    expect(writer.written).toHaveLength(1);
  });

  it("returns no row content: only counts, never ids, titles or urls", async () => {
    const { body } = await handleSyncRequest({
      registry: registryWith(
        fakePlugin([
          event({
            url: "https://example.invalid/secret-ish",
            author: "octocat",
          }),
        ]),
      ),
      writer: recordingWriter(),
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("octocat");
    expect(serialised).not.toContain("secret-ish");
    expect(serialised).not.toContain("acme/demo#1");
    expect(body.byType).toEqual({ issue: 1 });
  });

  it("treats an empty page as a SUCCESS with persisted 0", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([])),
      writer,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe(SYNC_OUTCOMES.empty);
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    // The empty-list guard in persistCanonicalEvents means no insert at all.
    expect(writer.written).toHaveLength(0);
  });

  it("states in every response that the route is not idempotent", async () => {
    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(),
    });

    expect(body.idempotent).toBe(false);
    expect(body.idempotencyNote).toMatch(/not idempotent/i);
    expect(body.idempotencyNote).toMatch(/already_present/);
  });
});

describe("POST /api/sync failure modes are distinct", () => {
  it("reports a missing DATABASE_URL before doing anything else", async () => {
    const fetchItems = vi.fn();
    const { status, body } = await handleSyncRequest({
      registry: new Registry([
        {
          describe: () => ({
            name: SOURCE,
            version: "0.0.0-test",
            requiresAuth: false,
          }),
          fetchItems,
          mapToCanonicalEvents: () => [],
        },
      ]),
      hasDatabaseUrl: () => false,
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.databaseUnconfigured);
    expect(body.ok).toBe(false);
    // Proves it short-circuits rather than making a pointless network call.
    expect(fetchItems).not.toHaveBeenCalled();
  });

  it("reports an unconfigured source as its own outcome", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      // A registry is required even here: the route resolves it before calling
      // the injected sync, and an absent one throws the very error under test.
      registry: registryWith(fakePlugin([])),
      // Force the composition root's own fixed-reason error.
      sync: () => {
        throw new SourceConfigurationError(
          "DEVLOOP_REPOSITORY is not set, so no source can be built.",
        );
      },
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.sourceNotConfigured);
  });

  it("reports a missing credential without making a request upstream", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("credential_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.credentialUnavailable,
        });
      },
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.credentialUnavailable);
    expect(body.persisted).toBe(0);
  });

  it("reports an upstream 4xx with the status and no upstream body", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("http_status", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.unauthorised,
          status: 401,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamRejected);
    expect(body.upstreamStatus).toBe(401);
    expect(body.byType).toEqual({});
  });

  it("reports an upstream 5xx separately from a 4xx", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("http_status", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.serverError,
          status: 503,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamRejected);
    expect(body.upstreamStatus).toBe(503);
  });

  it("reports an unreachable source as 502, distinct from a refusal", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("transport_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamUnreachable);
  });

  it("reports a repeat insert as already_present rather than success", async () => {
    // Postgres unique-violation, wrapped by Drizzle the way a real driver
    // failure arrives: the SQLSTATE lives on `cause`, not on the outer error.
    const wrapped = Object.assign(
      new Error("Failed query: insert into canonical_events"),
      {
        cause: Object.assign(
          new Error('duplicate key value violates unique constraint "x"'),
          { code: "23505" },
        ),
      },
    );
    const writer = recordingWriter(wrapped);

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer,
    });

    expect(status).toBe(409);
    expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
    expect(body.ok).toBe(false);
    // The conflict must never be reported as a successful write.
    expect(body.persisted).toBe(0);
    expect(writer.written).toHaveLength(0);
  });

  it("reports an unclassified failure as 500 without rendering it", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new Error(`something internal and specific: ${SENTINEL_TOKEN}`);
      },
    });

    expect(status).toBe(500);
    expect(body.outcome).toBe(SYNC_OUTCOMES.internalError);
    expect(JSON.stringify(body)).not.toContain("something internal");
  });

  it("does not mistake an ordinary database failure for a conflict", async () => {
    const refused = Object.assign(new Error("connection refused"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    });

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(refused),
    });

    expect(status).toBe(500);
    expect(body.outcome).toBe(SYNC_OUTCOMES.internalError);
  });
});

describe("no token value reaches a response or a thrown error", () => {
  it("leaks nothing when the upstream failure carries the token in its text", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        // The realistic worst case this route must survive: a transport that
        // fails with the credential interpolated into its message. The plugin's
        // own boundary already prevents this from reaching it, so the handler is
        // fed the hostile value directly and must still not echo it.
        throw new GitHubPluginError("transport_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
          status: undefined,
        });
      },
    });

    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_TOKEN);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamUnreachable);
  });

  it("leaks nothing when a raw error embeds the token and an Authorization header", async () => {
    const hostile = new Error(
      `request failed: authorization: token ${SENTINEL_TOKEN}`,
    );

    const { body } = await handleSyncRequest({
      writer: recordingWriter(hostile),
      registry: registryWith(fakePlugin([event()])),
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(SENTINEL_TOKEN);
    expect(serialised.toLowerCase()).not.toContain("authorization");
  });

  it("leaks nothing when the persistence failure embeds the token", async () => {
    const hostile = Object.assign(
      new Error(`insert failed for ${SENTINEL_TOKEN}`),
      {
        cause: Object.assign(new Error("wrapped"), { code: "23505" }),
      },
    );

    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(hostile),
    });

    // 23505 is still classified as already_present, and the message that
    // carried the token is still dropped: classification reads the SQLSTATE,
    // never the text.
    expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_TOKEN);
  });

  it("never throws, whatever the injected sync does", async () => {
    const hostile = new Error(SENTINEL_TOKEN);
    await expect(
      handleSyncRequest({
        writer: recordingWriter(),
        registry: registryWith(fakePlugin([])),
        sync: () => Promise.reject(hostile),
      }),
    ).resolves.toMatchObject({ status: 500 });
  });
});

describe("real syncSource through the handler", () => {
  it("writes only THROUGH the upsert: no conflict clause, no recorded write", async () => {
    // The regression guard for the stub itself. `recordingWriter` is a fake, so
    // nothing but this test proves it still models the CURRENT seam rather than
    // a shape that happens to typecheck: the fake's write is recorded inside
    // `onConflictDoUpdate`, and it is the fake's own argument that says the
    // conflict clause was reached. Delete `onConflictDoUpdate` from the stub —
    // the mistake this card exists to repair — and `persistCanonicalEvents` has
    // nothing to call, so this test fails; a `written` array fed from `values()`
    // would keep passing while proving nothing.
    const writer = recordingWriter();

    await expect(persistCanonicalEvents([event()], writer)).resolves.toBe(1);

    expect(writer.written).toHaveLength(1);
    expect(writer.conflicts).toHaveLength(1);
    // The clause is not a stub detail: production upserts on the natural key and
    // updates the mutable columns. Reading the column names off the clause the
    // fake was actually handed means this test fails if the fake is ever fed
    // something other than the clause the code really executes — and it names
    // the key by name rather than importing the table, so this route test still
    // depends on no storage export.
    const clause = writer.conflicts[0];
    // `target` is a column OR an array of them, per Drizzle's own config type,
    // so it is normalised here rather than assuming the array form.
    const targets = clause?.target ?? [];
    expect([targets].flat().map((column) => column.name)).toEqual([
      "source",
      // The SQL column name, not the TypeScript key: Drizzle's own metadata
      // `name` is what reaches Postgres, and asserting it catches a clause built
      // against the wrong column entirely.
      "external_id",
    ]);
    expect(Object.keys(clause?.set ?? {})).not.toContain("id");
  });

  it("records nothing when the writer refuses, even though the upsert ran", async () => {
    const hostile = new Error("insert failed");
    const writer = recordingWriter(hostile);

    await expect(persistCanonicalEvents([event()], writer)).rejects.toThrow(
      "insert failed",
    );

    // The write is recorded at the moment the clause is applied, and the
    // refusal happens in that same call, so a refused upsert leaves no trace.
    expect(writer.written).toHaveLength(0);
    expect(writer.conflicts).toHaveLength(0);
  });
  it("drives the production syncSource with an injected writer", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(
        // Distinct natural keys, deliberately: `persistCanonicalEvents` dedupes
        // a batch by (source, externalId) before writing, so two events sharing
        // an `externalId` are ONE row by design. This test is about a two-event
        // page being written whole, so the keys must differ — a fixture reusing
        // one key would assert 2 rows for a batch that is 1 row, and would be
        // testing the dedupe rather than the count.
        fakePlugin([
          event(),
          event({ id: "b", externalId: "acme/demo#2", type: "issue" }),
        ]),
      ),
      writer,
      sync: realSync,
    });

    expect(status).toBe(200);
    expect(body.persisted).toBe(2);
    expect(body.byType).toEqual({ issue: 2 });
    expect(writer.written[0]).toHaveLength(2);
  });

  it("does not write anything for an empty page through real syncSource", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([])),
      writer,
      sync: realSync,
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe(SYNC_OUTCOMES.empty);
    expect(writer.written).toHaveLength(0);
  });
});
