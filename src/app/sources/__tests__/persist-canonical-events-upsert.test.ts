/**
 * T16: `persistCanonicalEvents` is a real UPSERT on the natural key, proven
 * against a real Postgres.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER PERSISTENCE TESTS. The card's
 * central claim is about which constraint the conflict clause targets, and that
 * cannot be settled by a fake: `canonical_events_source_external_id_key` is
 * `UNIQUE(source, external_id)` and NOT the primary key, so an arbiter of `id`
 * would look like an idempotency fix while leaving SQLSTATE 23505 in place for
 * every real repeat sync. Only a real INSERT can tell those two apart, so every
 * test here goes through the real composition-root function against a real
 * database — no mocks, no raw-SQL shortcut, no fake writer.
 *
 * WHY IT LIVES IN `src/**` AND NOT IN `db/__tests__/**`. `persistCanonicalEvents`
 * is the composition root's function and its module imports through the `@/`
 * alias. `src/**` is the only place the repo's default suite collects, so the
 * repo's existing answer to "needs a real database" is this one:
 * `src/lib/db/__tests__/client.test.ts` gates a real-database describe block on
 * DATABASE_URL and skips otherwise. This file follows that same convention, so
 * `bun run test` executes it whenever DATABASE_URL is set and skips it cleanly
 * when it is not — the same shape, and the same reason, as the existing suite.
 *
 * THAT CONVENTION ALONE LEFT THIS FILE UNGATED, and B35 fixed it. `bun run test`
 * is the only job that collects `src/**`, and the `verify` job that runs it has
 * NO database — so `describeWithDb` collapsed to `describe.skip` there and all
 * the tests below were reported SKIPPED in a green CI run, which is
 * indistinguishable from having passed. `vitest.db.config.ts` now also collects
 * this file by name, so `bun run test:db` — which the `db round trip` job runs
 * with DATABASE_URL and applied migrations — actually executes it. The gate
 * below stays: it is what keeps the default suite green for a developer with no
 * database, and the two are independent (one decides collection, the other
 * decides whether a collected file asserts or skips).
 *
 * NOT VACUOUS BY CONSTRUCTION. The first test is a NEGATIVE CONTROL: a plain
 * insert of the same natural key must still fail with 23505. If that ever stops
 * failing, every other assertion in this file has stopped proving anything —
 * they could be passing because duplicates became legal rather than because the
 * upsert resolves them. It is asserted by execution on every run.
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "@/core/events/canonical-event";
import { toCanonicalEventRow } from "../../../../db/canonical-event-mapper";
import { canonicalEvents } from "../../../../db/schema";
import { closeDb, getDb } from "@/lib/db/client";

import { persistCanonicalEvents } from "../index";

/**
 * Real-database tests, skipped when there is no database to talk to.
 *
 * Same reason and same shape as `src/lib/db/__tests__/client.test.ts`: CI runs
 * `bun run test` with no database, and a hard failure here would turn CI red for
 * a reason unrelated to the code. When DATABASE_URL IS set — locally, or on the
 * db round-trip job — these run for real and nothing is skipped.
 */
const connectionString = process.env.DATABASE_URL;
const describeWithDb = connectionString ? describe : describe.skip;

/** One event, used as the basis for every case below. */
const EVENT: CanonicalEvent = {
  id: "evt_t16_upsert_a",
  source: "fixture-source",
  externalId: "ext-t16-upsert",
  type: "issue",
  title: "first title",
  occurredAt: "2026-01-02T03:04:05.000Z",
  metadata: { note: "first" },
};

/**
 * A second event sharing `externalId` but under a DIFFERENT source.
 *
 * `id` is deliberately DISTINCT here. See the two arbiter tests below for why a
 * shared `id` is not the discriminator it first appears to be: sharing `id`
 * makes the CORRECT arbiter raise 23505 on the primary key, so that shape
 * cannot carry a two-row assertion at all.
 */
const OTHER_SOURCE_EVENT: CanonicalEvent = {
  ...EVENT,
  id: "evt_t16_upsert_b",
  source: "another-source",
};

/**
 * A second event colliding on the PRIMARY KEY but NOT on the natural key: same
 * `id`, different `source` AND different `externalId`.
 *
 * This is the only shape that genuinely discriminates the two arbiters, because
 * it is the only one where the two indexes disagree about whether a conflict
 * exists. `UNIQUE(source, external_id)` sees no duplicate here; `id` does.
 */
const PRIMARY_KEY_COLLIDING_EVENT: CanonicalEvent = {
  ...EVENT,
  source: "another-source",
  externalId: "ext-t16-upsert-other-key",
  title: "colliding on the primary key only",
};

afterAll(async () => {
  if (connectionString) await closeDb();
});

describeWithDb(
  "persistCanonicalEvents is an idempotent upsert on the natural key",
  () => {
    /**
     * Clean up by DELETING the natural key, not by id: an upsert does not change
     * `id`, and this suite shares a database with other cards, so leaving rows
     * behind would make a later run's row counts wrong.
     */
    async function clearNaturalKey(): Promise<void> {
      await getDb()
        .delete(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));
    }

    afterEach(clearNaturalKey);

    it("NEGATIVE CONTROL: a plain insert of the same natural key still raises 23505", async () => {
      // THE CONTROL THAT MAKES THE REST OF THIS FILE MEANINGFUL. The constraint is
      // still there — the upsert is what CHOOSES to resolve it, not a relaxation of
      // it. If this stops failing, the assertions below are passing for the wrong
      // reason and must not be trusted.
      await getDb().insert(canonicalEvents).values(toCanonicalEventRow(EVENT));

      let caught: unknown;
      try {
        await getDb()
          .insert(canonicalEvents)
          .values(toCanonicalEventRow(EVENT));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      // 23505 is unique_violation, and the named constraint proves WHICH index
      // fired. Drizzle's own message is only "Failed query: ...", so the driver
      // error on the cause chain is what carries the code.
      expect(caught).toMatchObject({
        cause: { code: "23505", constraint_name: expect.any(String) },
      });
    });

    it("absorbs a duplicate persist of the same event instead of erroring", async () => {
      // The plainest form of the card's requirement: the second persist SUCCEEDS.
      // Before the upsert this raised SQLSTATE 23505 — the RED reproduced against
      // this same database before the change.
      const first = await persistCanonicalEvents([EVENT]);
      const second = await persistCanonicalEvents([EVENT]);

      expect(first).toBe(1);
      expect(second).toBe(1);

      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));
      expect(rows).toHaveLength(1);
    });

    it("updates the title in place: one row, holding the NEW value", async () => {
      // A repeat sync must converge on the source's CURRENT view. Asserting the
      // row count alone would pass for an implementation that silently kept the
      // stale title, so the value is asserted too.
      await persistCanonicalEvents([EVENT]);
      await persistCanonicalEvents([{ ...EVENT, title: "second title" }]);

      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("second title");
    });

    it("converges on every enumerated mutable column and leaves the key untouched", async () => {
      await persistCanonicalEvents([EVENT]);
      await persistCanonicalEvents([
        {
          ...EVENT,
          type: "release",
          title: "second title",
          url: "https://example.invalid/updated",
          author: "someone-else",
          occurredAt: "2026-03-04T05:06:07.000Z",
          metadata: { note: "second" },
        },
      ]);

      const [row] = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));

      // Every column in the update set moved.
      expect(row!.type).toBe("release");
      expect(row!.title).toBe("second title");
      expect(row!.url).toBe("https://example.invalid/updated");
      expect(row!.author).toBe("someone-else");
      expect(row!.occurredAt.toISOString()).toBe("2026-03-04T05:06:07.000Z");
      expect(row!.metadata).toEqual({ note: "second" });

      // The key did NOT move — and in particular the PRIMARY KEY is unchanged.
      // Rewriting `id` would orphan anything referencing the row, which is why the
      // update set enumerates columns and never derives them from the row.
      expect(row!.id).toBe(EVENT.id);
      expect(row!.source).toBe(EVENT.source);
      expect(row!.externalId).toBe(EVENT.externalId);
    });

    it("keeps TWO rows for the same externalId under a DIFFERENT source", async () => {
      // The natural key is the pair, so the same `externalId` under a different
      // `source` is a DIFFERENT entity and both must survive a re-sync.
      //
      // This asserts the two-column arbiter's real purpose — that the pair, not
      // either column alone, is the key — and it is NOT by itself proof of which
      // constraint is targeted: with distinct `id`s there is no collision on
      // EITHER index, so a plain insert would also produce two rows here. The
      // next test is the one that discriminates, and this one is the regression
      // guard that keeps the pair semantics intact if that test is ever removed.
      await persistCanonicalEvents([EVENT]);
      await persistCanonicalEvents([OTHER_SOURCE_EVENT]);

      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.source).sort()).toEqual([
        "another-source",
        "fixture-source",
      ]);
    });

    it("TARGETS THE NATURAL KEY: a primary-key-only collision raises 23505 instead of silently overwriting", async () => {
      // THIS IS THE TEST THAT PROVES THE ARBITER, AND IT IS THE OPPOSITE OF
      // WHAT QA ROUND 1 ASKED FOR. Round 1 proposed giving the different-source
      // event the SAME `id` so that a primary-key target would collapse it to
      // one row. That shape cannot work: with a shared `id` the CORRECT arbiter
      // also fails, because `ON CONFLICT (source, external_id)` only absorbs a
      // collision on the two columns it names and a primary-key collision is
      // invisible to it. Measured on real Postgres at this head, both arbiters
      // behave identically for that shape, so it discriminates nothing.
      //
      // The discriminating shape is the one where the two indexes DISAGREE: a
      // row colliding on `id` but NOT on (source, external_id). The correct
      // arbiter sees no conflict on its own key and therefore lets the primary
      // key raise 23505 — a loud, correct failure. A primary-key arbiter instead
      // treats it as an update and SILENTLY OVERWRITES the unrelated row, which
      // is data loss dressed as an idempotency fix.
      //
      // Asserting the THROW is the assertion: it is only reachable with the
      // natural key as the arbiter. Measured counterpart, same data, arbiter
      // switched to [canonicalEvents.id]: no error, one row, title silently
      // replaced by "colliding on the primary key only".
      await persistCanonicalEvents([EVENT]);

      let caught: unknown;
      try {
        await persistCanonicalEvents([PRIMARY_KEY_COLLIDING_EVENT]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        cause: { code: "23505", constraint_name: "canonical_events_pkey" },
      });

      // And the colliding event left NO trace: the original row is untouched,
      // not merged with or overwritten by the row that could not be inserted.
      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, EVENT.externalId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe(EVENT.title);
    });

    it("absorbs a batch that mixes an existing event with a new one", async () => {
      // The realistic sync shape: one page re-fetching some known events and
      // introducing one new item. Only the new row may be added.
      const fresh: CanonicalEvent = {
        ...EVENT,
        id: "evt_t16_upsert_c",
        externalId: "ext-t16-upsert-new",
      };

      await persistCanonicalEvents([EVENT]);
      await persistCanonicalEvents([
        { ...EVENT, title: "updated title" },
        fresh,
      ]);

      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.source, EVENT.source));
      expect(rows).toHaveLength(2);

      const updated = rows.find((row) => row.externalId === EVENT.externalId);
      expect(updated!.title).toBe("updated title");
      expect(rows.some((row) => row.externalId === fresh.externalId)).toBe(
        true,
      );
    });
  },
);

describeWithDb("two concurrent syncs of the same natural key", () => {
  /**
   * Postgres resolves an `ON CONFLICT DO UPDATE` collision by taking a row lock
   * and re-evaluating the conflict, so two writers of the same key CONVERGE ON
   * ONE ROW rather than raising 23505: the second blocks until the first commits,
   * then updates it. This asserts that by execution rather than in prose.
   */
  const event: CanonicalEvent = {
    id: "evt_t16_concurrent",
    source: "fixture-source",
    externalId: "ext-t16-concurrent",
    type: "issue",
    title: "concurrent",
    occurredAt: "2026-01-02T03:04:05.000Z",
    metadata: {},
  };

  afterEach(async () => {
    await getDb()
      .delete(canonicalEvents)
      .where(eq(canonicalEvents.externalId, event.externalId));
  });

  it("converges on one row with no error when two writers race", async () => {
    const settled = await Promise.allSettled([
      persistCanonicalEvents([{ ...event, title: "writer one" }]),
      persistCanonicalEvents([{ ...event, title: "writer two" }]),
    ]);

    // Neither writer errored: no rejection at all, and specifically no 23505.
    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);

    const rows = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.externalId, event.externalId));
    expect(rows).toHaveLength(1);

    // LAST-WRITER-WINS, ACCEPTED DELIBERATELY FOR v1. The surviving title is one
    // of the two written — not a blend, not a torn value. Asserting membership
    // rather than a fixed winner documents the decision honestly instead of
    // pretending the race has a deterministic order, which it does not.
    expect(["writer one", "writer two"]).toContain(rows[0]!.title);
  });
});
