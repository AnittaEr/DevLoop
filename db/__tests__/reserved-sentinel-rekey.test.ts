/**
 * B42: migration `0003` re-keys a plugin row that carries the remediation
 * sentinel `_devloop_legacy_non_object` as REAL data, so the writer stops
 * refusing it forever.
 *
 * THE DEFECT UNDER TEST. `0002_loud_johnny_blaze.sql` wraps the original metadata
 * of any pre-existing NON-object row under `_devloop_legacy_non_object`, and the
 * writer (`db/canonical-event-mapper.ts`, `RESERVED_METADATA_KEYS`) refuses to
 * emit that key at the top level. But `0002`'s remediation only matches rows
 * whose metadata is NOT a JSON object, so a row that is a genuine object and
 * happens to use the sentinel name as plugin data is never repaired — it is
 * simply left in a shape the writer refuses forever. That is not "un-remediated";
 * it can never converge again.
 *
 * WHY THIS FILE NEEDS A REAL DATABASE AND WHY IT REPLAYS MIGRATIONS. The defect
 * lives in the DATA a migration leaves behind, not in any TypeScript: asserting
 * it against a freshly migrated database is impossible by construction, because
 * a fresh database has no pre-`0002` rows. So this builds the legacy state the
 * way the earlier upgrade-path block in `canonical-events-persistence.test.ts`
 * does — apply `0000`+`0001`, insert the illegal/colliding rows by hand, then
 * run the real `0002` and the real `0003` through the real statement-breakpoint
 * replay — inside its own SCHEMA, so it cannot disturb whatever `DATABASE_URL`
 * points at.
 *
 * NON-VACUITY. These tests are only meaningful if they FAIL when the repair is
 * removed from `0003`. The recorded RED/GREEN runs are on the card; the
 * `[repair-mutation]` tag marks the cases that go red on its removal, so a future
 * deletion points at a name.
 *
 * ONE ORDERED BUILD. Like the earlier upgrade-path block there is no per-test
 * cleanup: the legacy database is constructed across the cases, so they share
 * state and MUST run in declaration order (`fileParallelism: false` in
 * `vitest.db.config.ts` makes files serial, and vitest runs a file's cases in
 * order). Each case therefore names the state it depends on.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  CanonicalEvent,
  JsonObject,
} from "../../src/core/events/canonical-event";
import {
  fromCanonicalEventRow,
  RESERVED_METADATA_KEYS,
  toCanonicalEventRow,
} from "../canonical-event-mapper";

/** The sentinel `0002` wraps under, and the writer refuses to emit. */
const RESERVED = "_devloop_legacy_non_object";

/**
 * The key `0003` moves a colliding payload to.
 *
 * Named here rather than interpolated from the migration so that a rename of
 * either constant breaks these tests loudly instead of leaving them green and
 * vacuous — the same reason the reserved-key test pins its own constant.
 */
const REKEYED = "_devloop_rekeyed_from_reserved_legacy_non_object";

/** The migrations that existed BEFORE the shape CHECK, applied in order. */
const LEGACY_TAGS = ["0000_tiny_nightshade", "0001_parched_talon"] as const;

/**
 * Runs `run` against a connection PINNED to `schema`.
 *
 * `reset` drops and recreates the sandbox on entry; without it the connection
 * merely attaches. That distinction is load-bearing rather than convenient:
 * resetting per call destroys the state later cases assert on. DROP runs BEFORE
 * CREATE because dropping a schema the connection's `search_path` already
 * points at leaves Postgres with "no schema has been selected to create in".
 * Both measured, both inherited from the existing sandbox helper's rationale.
 *
 * Each describe below owns its own schema because each needs its own LEGACY
 * database: they build different pre-`0003` states, and a shared one would make
 * a case prove only that an already-repaired table ignores the UPDATE's
 * predicate rather than that the predicate matches or declines to match the
 * shape under test.
 */
async function withSandbox<T>(
  schema: string,
  run: (client: postgres.Sql) => Promise<T>,
  options: { readonly reset: boolean },
): Promise<T> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    if (options.reset) {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
    }
    await client.unsafe(`SET search_path TO "${schema}"`);
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Applies the named migration files verbatim, in order, splitting on the exact
 * marker drizzle's own migrator uses (`drizzle-orm/migrator` ->
 * `query.split("--> statement-breakpoint")`) and executing each part in ONE
 * transaction — so this is the code path `db:migrate` runs, not an
 * approximation of it.
 */
async function applyMigrations(client: postgres.Sql, tags: readonly string[]) {
  for (const tag of tags) {
    const file = readFileSync(
      new URL(`../migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    await client.begin(async (tx) => {
      for (const statement of file.split("--> statement-breakpoint")) {
        if (statement.trim() === "") continue;
        await tx.unsafe(statement);
      }
    });
  }
}

/**
 * Applies ONE migration file and returns the NOTICE and WARNING text it emitted.
 *
 * Its own connection, because a caller cannot retrofit notice collection onto
 * the `postgres` handle it already holds: `onNotice` is fixed when the client is
 * constructed, and notices are only ever delivered to a connection that asked
 * for them. Assertions about what a migration REPORTS have to run the statements
 * through this rather than through `applyMigrations`, or they would silently
 * assert nothing — which is exactly how the clash exclusion went unreported in
 * review round 1.
 */
async function applyCapturingNotices(
  tag: string,
  schema: string,
): Promise<string[]> {
  const seen: string[] = [];
  // `onnotice`, not `onNotice`: this postgres.js version's Options type spells it
  // lowercase, and the capitalised form is silently dropped — which is why the
  // first attempt at this assertion captured nothing at all.
  const listener = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: (n) => seen.push(`${n.severity}: ${n.message}`),
  });
  try {
    await listener.unsafe(`SET search_path TO "${schema}"`);
    const file = readFileSync(
      new URL(`../migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of file.split("--> statement-breakpoint")) {
      if (statement.trim() === "") continue;
      await listener.unsafe(statement);
    }
  } finally {
    await listener.end();
  }
  return seen;
}

/** Every row's `id` and `metadata`, ordered, for a whole-table assertion. */
async function readAll(client: postgres.Sql) {
  return client<{ id: string; metadata: Record<string, unknown> }[]>`
    SELECT id, metadata FROM canonical_events ORDER BY id`;
}

/** Inserts one legacy fixture row into an already-migrated legacy schema. */
async function insertLegacy(
  client: postgres.Sql,
  row: { id: string; externalId: string; title: string; metadata: string },
) {
  await client.unsafe(
    `
      INSERT INTO canonical_events
        (id, source, external_id, type, title, occurred_at, metadata)
      VALUES ('${row.id}', 'fixture-source', '${row.externalId}', 'mention',
              '${row.title}', now(), '${row.metadata}'::jsonb)
    `,
  );
}

describe("0003 re-keys a plugin row that used the remediation sentinel as data", () => {
  const SANDBOX_SCHEMA = "reserved_sentinel_rekey_probe";

  beforeAll(async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        await applyMigrations(client, LEGACY_TAGS);
      },
      { reset: true },
    );
  });

  afterAll(async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        await client.unsafe(
          `DROP SCHEMA IF EXISTS "${SANDBOX_SCHEMA}" CASCADE`,
        );
      },
      { reset: false },
    );
  });

  it("[repair-mutation] the colliding row is legal on the legacy schema, proving it was reachable", async () => {
    // Its own case because it is the PREMISE: if `0001` had rejected a genuine
    // object, or if the name had been impossible to write, the repair below
    // would be proving nothing about a row that could ever have existed.
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        await client.unsafe(`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES ('plugin-collision', 'fixture-source', 'ext-plugin-collision', 'mention',
                  'plugin row using the sentinel name as data', now(),
                  '{"_devloop_legacy_non_object": {"real":"plugin data"}, "other": 1}'::jsonb)
        `);
        // The CONTROL: a row whose metadata is not an object, i.e. exactly what
        // `0002` was written to remediate. It must come out the other side
        // byte-identical, which is what makes it a control rather than a second
        // example.
        await client.unsafe(`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES ('control-sentinel', 'fixture-source', 'ext-control-sentinel', 'mention',
                  'row whose metadata is a non-object (pre-0002)', now(), '[1,2]'::jsonb)
        `);
        // A second control: an ORDINARY row with no reserved-looking key at all.
        // The repair must not touch it either.
        await client.unsafe(`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES ('ordinary', 'fixture-source', 'ext-ordinary', 'mention',
                  'ordinary plugin row', now(), '{"nested": {"a": 1}}'::jsonb)
        `);

        const rows = await readAll(client);
        expect(rows.map((row) => row.id)).toEqual([
          "control-sentinel",
          "ordinary",
          "plugin-collision",
        ]);
      },
      { reset: false },
    );
  });

  it("[repair-mutation] 0002 leaves the colliding row untouched — the defect it creates", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        await applyMigrations(client, ["0002_loud_johnny_blaze"]);

        const rows = await readAll(client);
        const colliding = rows.find((row) => row.id === "plugin-collision")!;

        // The premise of the whole card, measured: `0002` matched on
        // `jsonb_typeof(metadata) IS DISTINCT FROM 'object'`, and this row IS an
        // object, so it passes through untouched — carrying the sentinel as real
        // data, in the one shape the writer refuses.
        expect(colliding.metadata).toEqual({
          [RESERVED]: { real: "plugin data" },
          other: 1,
        });
      },
      { reset: false },
    );
  });

  it("[repair-mutation] the writer refuses that row, so the event can never converge", async () => {
    // The data-availability half of the defect, asserted through the real writer
    // on the real row `0002` left behind. Without this the card would only claim
    // a cosmetic re-key; this is the behaviour that actually strands an event.
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const rows = await readAll(client);
        const colliding = rows.find((row) => row.id === "plugin-collision")!;

        expect(() =>
          toCanonicalEventRow({
            id: "plugin-collision",
            source: "fixture-source",
            externalId: "ext-plugin-collision",
            type: "mention",
            title: "plugin row using the sentinel name as data",
            occurredAt: "2026-10-04T12:31:07.000Z",
            metadata: colliding.metadata as JsonObject,
          }),
        ).toThrow(TypeError);
      },
      { reset: false },
    );
  });

  it("[repair-mutation] 0003 re-keys the colliding row and preserves its payload and siblings", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);

        const rows = await readAll(client);
        const colliding = rows.find((row) => row.id === "plugin-collision")!;

        // The sentinel name is GONE from the top level — which is the whole
        // point, since the writer's refusal keys on exactly that.
        expect(Object.keys(colliding.metadata)).not.toContain(RESERVED);

        // The plugin's payload was MOVED, not dropped and not overwritten: same
        // value under the new key, with every sibling key intact and in place.
        // A repair that satisfied the writer by deleting the payload would pass
        // the assertion above and destroy user data, so the value is checked.
        expect(colliding.metadata).toEqual({
          other: 1,
          [REKEYED]: { real: "plugin data" },
        });
      },
      { reset: false },
    );
  });

  it("[repair-mutation] the writer now accepts the re-keyed row", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const rows = await readAll(client);
        const repaired = rows.find((row) => row.id === "plugin-collision")!;

        // Round-tripped through the WRITER, not merely through the column: the
        // event that could never converge now produces a row, and reading it back
        // yields the metadata the plugin originally wrote.
        const event: CanonicalEvent = {
          id: "plugin-collision",
          source: "fixture-source",
          externalId: "ext-plugin-collision",
          type: "mention",
          title: "plugin row using the sentinel name as data",
          occurredAt: "2026-10-04T12:31:07.000Z",
          metadata: repaired.metadata as JsonObject,
        };

        const row = toCanonicalEventRow(event);
        const read = fromCanonicalEventRow(row);

        expect(JSON.parse(JSON.stringify(read.metadata))).toEqual({
          other: 1,
          [REKEYED]: { real: "plugin data" },
        });
      },
      { reset: false },
    );
  });

  it("[repair-mutation] leaves the correctly remediated row exactly as 0002 made it", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const rows = await readAll(client);
        const control = rows.find((row) => row.id === "control-sentinel")!;

        // c4's other direction. `0002` wrapped a NON-object under the sentinel;
        // that shape is the remediation, and re-keying it would DESTROY the
        // original payload and rewrite a row the writer is entitled to refuse.
        expect(control.metadata).toEqual({ [RESERVED]: [1, 2] });
      },
      { reset: false },
    );
  });

  it("leaves an ordinary row untouched", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const rows = await readAll(client);
        expect(rows.find((row) => row.id === "ordinary")!.metadata).toEqual({
          nested: { a: 1 },
        });
      },
      { reset: false },
    );
  });

  it("is idempotent: a second application changes no row at all", async () => {
    // PM's two-run property, asserted rather than argued. The repair matches only
    // rows still carrying the OLD key, and a row it has already touched no longer
    // does — so re-running is a byte-level no-op, including for the control.
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const before = await readAll(client);
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);
        const after = await readAll(client);

        expect(after).toEqual(before);
        expect(
          after.find((row) => row.id === "plugin-collision")!.metadata,
        ).toEqual({ other: 1, [REKEYED]: { real: "plugin data" } });
        expect(
          after.find((row) => row.id === "control-sentinel")!.metadata,
        ).toEqual({ [RESERVED]: [1, 2] });
      },
      { reset: false },
    );
  });

  it("a third application is still a no-op, and the control never drifts", async () => {
    await withSandbox(
      SANDBOX_SCHEMA,
      async (client) => {
        const before = await readAll(client);
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);
        const after = await readAll(client);

        expect(after).toEqual(before);
        expect(
          after.find((row) => row.id === "control-sentinel")!.metadata,
        ).toEqual({ [RESERVED]: [1, 2] });
      },
      { reset: false },
    );
  });
});

/**
 * The genuinely ambiguous row: the reserved key ALONE, wrapping a NON-object.
 *
 * This is byte-indistinguishable from what `0002` itself produced, so `0003`
 * deliberately does not touch it. It is its own block because it needs its own
 * legacy database: the shared one above has already been repaired, so inserting
 * the shape there would prove only that a re-keyed table ignores the UPDATE's
 * predicate, not that the predicate declines to match this shape.
 */
describe("0003 declines to guess on a row indistinguishable from the remediation", () => {
  const AMBIGUOUS_SCHEMA = "reserved_sentinel_ambiguous_probe";

  beforeAll(async () => {
    await withSandbox(
      AMBIGUOUS_SCHEMA,
      async (client) => {
        await applyMigrations(client, LEGACY_TAGS);
        // A PLUGIN row that used the sentinel name alone, wrapping a non-object.
        // `0001` accepted it (its metadata is an object), and `0002` will not
        // match it — so it survives `0002` in the remediation's exact shape
        // without having been remediated at all.
        await client.unsafe(`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES ('ambiguous-plugin', 'fixture-source', 'ext-ambiguous', 'mention',
                  'plugin row whose only key is the sentinel', now(),
                  '{"_devloop_legacy_non_object": 42}'::jsonb)
        `);
        // And the row `0002` genuinely produced, for the same shape.
        await client.unsafe(`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES ('genuine-remediation', 'fixture-source', 'ext-genuine', 'mention',
                  'row 0002 really did remediate', now(), '"text"'::jsonb)
        `);

        await applyMigrations(client, ["0002_loud_johnny_blaze"]);
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);
      },
      { reset: true },
    );
  });

  afterAll(async () => {
    await withSandbox(
      AMBIGUOUS_SCHEMA,
      async (client) => {
        await client.unsafe(
          `DROP SCHEMA IF EXISTS "${AMBIGUOUS_SCHEMA}" CASCADE`,
        );
      },
      { reset: false },
    );
  });

  it("leaves BOTH rows in the remediation shape rather than corrupting one of them", async () => {
    await withSandbox(
      AMBIGUOUS_SCHEMA,
      async (client) => {
        const rows = await client<
          { id: string; metadata: Record<string, unknown> }[]
        >`SELECT id, metadata FROM canonical_events ORDER BY id`;

        // Both are untouched and therefore identical. A repair that could tell
        // them apart would have to be reading something neither row carries, so
        // this asserts the honest outcome: the ambiguity is preserved, and the
        // migration's WARNING tells the operator which rows are in it.
        expect(rows).toEqual([
          { id: "ambiguous-plugin", metadata: { [RESERVED]: 42 } },
          { id: "genuine-remediation", metadata: { [RESERVED]: "text" } },
        ]);
      },
      { reset: false },
    );
  });
});

describe("0003 never overwrites a value already stored under the re-key target", () => {
  const CLASH_SCHEMA = "reserved_sentinel_clash_probe";

  beforeAll(async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        await applyMigrations(client, LEGACY_TAGS);

        // QA REVIEW ROUND 1'S DEFECT, reproduced here as a fixture. The repair is
        // `(metadata - reserved) || jsonb_build_object(target, ...)`, and jsonb
        // `||` is RIGHT-HAND-WINS, so before the correction this row came out as
        // `{[REKEYED]: {real: plugin data}}` and the plugin's own
        // `{"plugin":"PRECIOUS"}` was gone — silently destroyed by the very
        // migration whose header promises "REPAIR, NOT DELETE".
        //
        // Reachable, not theoretical: a plugin that already moved its payloads to
        // the key `0003` invents, and still writes the legacy sentinel name,
        // lands exactly here on its next `db:migrate`.
        await insertLegacy(client, {
          id: "both-keys",
          externalId: "ext-both-keys",
          title: "plugin row using BOTH names as data",
          metadata: `{"${RESERVED}": {"real":"plugin data"}, "${REKEYED}": {"plugin":"PRECIOUS"}}`,
        });

        // A control that the SAME migration still repairs in the same run, so a
        // fix that simply disabled the UPDATE wholesale cannot pass by being
        // uniformly cautious.
        await insertLegacy(client, {
          id: "repaired-alongside",
          externalId: "ext-repaired-alongside",
          title: "ordinary collision repaired in the same run",
          metadata: `{"${RESERVED}": {"real":"plugin data"}, "other": 1}`,
        });

        // And the row `0002` genuinely produced, which must stay untouched.
        await insertLegacy(client, {
          id: "genuine-remediation",
          externalId: "ext-genuine-clash",
          title: "row 0002 really did remediate",
          metadata: `"text"`,
        });

        await applyMigrations(client, ["0002_loud_johnny_blaze"]);
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);
      },
      { reset: true },
    );
  });

  afterAll(async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        await client.unsafe(`DROP SCHEMA IF EXISTS "${CLASH_SCHEMA}" CASCADE`);
      },
      { reset: false },
    );
  });

  it("[overwrite-mutation] preserves BOTH payloads on the both-keys row", async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        const rows = await readAll(client);
        const both = rows.find((row) => row.id === "both-keys")!;

        // The plugin's value under the target key is intact. THIS is the
        // assertion that was missing when QA found the defect: before the
        // `AND NOT (... ? target)` correction this object was
        // `{"plugin":"PRECIOUS"}`-free, and nothing in the suite noticed.
        expect(both.metadata).toEqual({
          [RESERVED]: { real: "plugin data" },
          [REKEYED]: { plugin: "PRECIOUS" },
        });
      },
      { reset: false },
    );
  });

  it("still repairs the ordinary collision in the same run", async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        const rows = await readAll(client);

        // The correction must be a targeted exclusion, not a decision to repair
        // nothing. Without this, a migration that declined to touch any row
        // would satisfy the assertion above.
        expect(
          rows.find((row) => row.id === "repaired-alongside")!.metadata,
        ).toEqual({ other: 1, [REKEYED]: { real: "plugin data" } });
      },
      { reset: false },
    );
  });

  it("leaves the genuinely remediated row untouched", async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        const rows = await readAll(client);

        expect(
          rows.find((row) => row.id === "genuine-remediation")!.metadata,
        ).toEqual({ [RESERVED]: "text" });
      },
      { reset: false },
    );
  });

  it("[overwrite-mutation] WARNS about the clash rather than resolving it silently", async () => {
    // The exclusion must be VISIBLE. A row declined without a count would be
    // indistinguishable, to whoever reads the migrate output, from a row that
    // was never there — which is how a lost payload becomes permanent.
    //
    // This asserts the REPORT, not the row. An earlier version of this case
    // counted matching rows and stayed GREEN when the exclusion was deleted,
    // because the row exists either way — only its metadata differs. Asserting
    // the emitted WARNING is what makes the reporting non-vacuous.
    const seen = await applyCapturingNotices(
      "0003_rekey_reserved_sentinel_collisions",
      CLASH_SCHEMA,
    );

    const warnings = seen.filter((line) => line.startsWith("WARNING"));
    expect(warnings).toHaveLength(2);
    expect(
      warnings.some(
        (line) =>
          line.includes("carry BOTH") &&
          line.includes(REKEYED) &&
          line.includes("1 row(s)"),
      ),
    ).toBe(true);
  });

  it("is idempotent: a second application changes no row at all", async () => {
    await withSandbox(
      CLASH_SCHEMA,
      async (client) => {
        const before = await readAll(client);
        await applyMigrations(client, [
          "0003_rekey_reserved_sentinel_collisions",
        ]);
        const after = await readAll(client);

        expect(after).toEqual(before);
      },
      { reset: false },
    );
  });
});

describe("the re-key target is not itself reserved", () => {
  it("is absent from the writer's reserved namespace", () => {
    // If the migration had re-keyed the payload to a name the writer refuses, it
    // would have reproduced the very defect it repairs: the row would still be
    // unwritable, just under a different key. This is the assertion that closes
    // that loop, and it fails loudly if anyone adds the new key to
    // `RESERVED_METADATA_KEYS` without re-examining this migration.
    expect(RESERVED_METADATA_KEYS).not.toContain(REKEYED);
    expect(RESERVED_METADATA_KEYS).toEqual([RESERVED]);
  });
});
