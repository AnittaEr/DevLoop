/**
 * T18: the reserved remediation key `_devloop_legacy_non_object` is
 * unrepresentable in the canonical-event writer.
 *
 * WHAT IS UNDER TEST. `toCanonicalEventRow` is the single place a
 * `CanonicalEvent` becomes a row, so it is the only place a reserved key can be
 * made unrepresentable: every write in this codebase goes through it (no caller
 * builds a row literal without it), and a row that never carries the key cannot
 * collide with the remediation shape `db/migrations/0002_loud_johnny_blaze.sql`
 * produces. No database is needed — the guard is pure and fires before anything
 * is bound — but the file lives under `db/__tests__/` because that is where the
 * mapper's other tests are and which `vitest.db.config.ts` collects.
 *
 * NON-VACUITY. These tests are only meaningful if they FAIL when the guard is
 * deleted. The card requires that to be proven by mutation rather than asserted;
 * the recorded RED/GREEN runs are on the card. The `guard-mutation` tag marks
 * the test that fails on removal, so a future deletion points at one name.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../src/core/events/canonical-event";
import type { NewCanonicalEventRow } from "../schema";
import {
  fromCanonicalEventRow,
  RESERVED_METADATA_KEYS,
  toCanonicalEventRow,
} from "../canonical-event-mapper";

/**
 /**
  * The row's `metadata` as a plain object.
  *
  * The column is `jsonb`, so its TypeScript type is not a plain object and
  * `Object.keys` would not accept it. Assertions here are all about the JSON
  * value that actually reaches Postgres, which is what this yields.
  */
function rowMetadata(row: NewCanonicalEventRow): Record<string, unknown> {
  return row.metadata as Record<string, unknown>;
}

/** The reserved key, named here rather than interpolated everywhere so a
 * migration that ever renames it (out of scope for this card) breaks these
 * tests loudly instead of leaving them green and vacuous.
 */
const RESERVED = "_devloop_legacy_non_object";

/** A minimal, valid event whose metadata the caller varies per test. */
function eventWithMetadata(
  metadata: CanonicalEvent["metadata"],
  id = "evt_01HQZX0000000000000000101",
): CanonicalEvent {
  return {
    id,
    source: "fixture-source",
    externalId: `ext-${id}`,
    type: "release",
    title: "Reserved key guard",
    // Offset-bearing and calendar-valid: nothing else about the event is meant
    // to be rejected here, so a throw can only come from the metadata guard.
    occurredAt: "2026-10-04T12:31:07.000Z",
    metadata,
  };
}

describe("the reserved remediation key cannot reach a row", () => {
  it("[guard-mutation] rejects metadata carrying the reserved top-level key", () => {
    const event = eventWithMetadata({ [RESERVED]: 42 });

    // TypeError, the same loud-validation shape used for every other
    // unrepresentable value at this boundary, so one `catch` handles them all.
    expect(() => toCanonicalEventRow(event)).toThrow(TypeError);

    // The message must name the offending key AND state the top-level-only
    // scope, because the message is the only thing a plugin author sees and it
    // is where they learn that a *nested* key is fine.
    let message = "";
    try {
      toCanonicalEventRow(event);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(RESERVED);
    expect(message).toContain("TOP-LEVEL");
  });

  it("[guard-mutation] rejects it even alongside legitimate sibling keys", () => {
    // Proves the guard fires on the reserved key itself and is not a blanket
    // rejection of any metadata worth noticing: a plugin that happens to carry
    // real data alongside a colliding key is still refused, loudly.
    expect(() =>
      toCanonicalEventRow(
        eventWithMetadata({ normal: 2, [RESERVED]: 42, other: "x" }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects it whatever the reserved value's type", () => {
    // The remediation wraps the *original* column value, which was not a JSON
    // object — so a string, an array and an object are all shapes a plugin could
    // plausibly collide with. All are refused.
    for (const value of [42, "text", [1, 2], { a: 1 }, null, false]) {
      expect(() =>
        toCanonicalEventRow(eventWithMetadata({ [RESERVED]: value })),
      ).toThrow(TypeError);
    }
  });

  it("leaves the caller's event untouched when it rejects", () => {
    // Rejection must not half-normalise: a caller that catches the error and
    // retries with corrected metadata must not find its object already mutated.
    const metadata = { [RESERVED]: 42, keep: "me" };
    const event = eventWithMetadata(metadata);

    expect(() => toCanonicalEventRow(event)).toThrow(TypeError);

    expect(metadata).toEqual({ [RESERVED]: 42, keep: "me" });
    expect(Object.keys(metadata)).toEqual([RESERVED, "keep"]);
  });

  it("does not reject an inherited key of the reserved name", () => {
    // Control on the guard's mechanism: it reads OWN top-level keys, so an
    // object that merely inherits the reserved name is accepted. `in` would
    // reject this, and `structuredClone` (which the mapper already applies)
    // drops the inherited property anyway — so it never reaches the column.
    const metadata = Object.create({ [RESERVED]: "inherited" }) as Record<
      string,
      never
    >;
    metadata.normal = 1 as never;

    const row = toCanonicalEventRow(eventWithMetadata(metadata));

    expect(rowMetadata(row)).toEqual({ normal: 1 });
    expect(Object.keys(rowMetadata(row))).not.toContain(RESERVED);
  });
});

describe("the guard is not over-broad: only the top-level key is reserved", () => {
  it("accepts a sibling key that merely starts with the reserved name", () => {
    const metadata = { [`${RESERVED}_nested`]: 1, normal: 2 };

    const row = toCanonicalEventRow(eventWithMetadata(metadata));

    // Persisted unchanged — a prefix match here would be data loss, because a
    // reserved *prefix* is not what the remediation writes.
    expect(row.metadata).toEqual(metadata);
  });

  it("accepts a nested occurrence of the reserved key and round-trips it", () => {
    const metadata = { nested: { [RESERVED]: 1 } };

    const row = toCanonicalEventRow(eventWithMetadata(metadata));

    // Round-tripped through the reader as well, so this is a persistence
    // claim and not merely "the guard did not fire".
    const read = fromCanonicalEventRow({ ...row, occurredAt: row.occurredAt });
    expect(JSON.parse(JSON.stringify(read.metadata))).toEqual(metadata);
  });

  it("accepts a reserved key nested deeper still", () => {
    const metadata = { a: { b: { [RESERVED]: [1, { c: 2 }] } } };

    const row = toCanonicalEventRow(eventWithMetadata(metadata));

    expect(row.metadata).toEqual(metadata);
  });

  it("still accepts ordinary metadata with no reserved-looking key", () => {
    // The existing suites already cover rich metadata; this is the floor, so a
    // guard that rejected too much could not pass the sibling tests above by
    // accident.
    const metadata = { number: 3.5, zero: 0, nothing: null, list: [1, "two"] };

    const row = toCanonicalEventRow(eventWithMetadata(metadata));

    expect(rowMetadata(row)).toEqual(metadata);
    expect(Object.keys(rowMetadata(row))).toEqual([
      "number",
      "zero",
      "nothing",
      "list",
    ]);
  });
});

describe("the reserved key list matches the migration's remediation key", () => {
  it("exports exactly the one key migration 0002 wraps under", () => {
    // If a second key is ever reserved it must be a deliberate, reviewed
    // addition, and this test is where it becomes visible.
    expect(RESERVED_METADATA_KEYS).toEqual([RESERVED]);
  });
});
