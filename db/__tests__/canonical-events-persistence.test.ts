/**
 * T7b: the canonical event survives a real round trip through Postgres.
 *
 * This is the whole point of the card: not that a migration applies, but that a
 * `CanonicalEvent` can be written and read back losslessly. Everything here runs
 * against the real local Postgres (no mocks, no skip guard) — see
 * `vitest.db.setup.ts`.
 *
 * Run with `bun run test:db` after `bun run db:migrate`.
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../src/core/events/canonical-event";
import { CANONICAL_EVENT_TYPES } from "../../src/core/events/canonical-event";
import {
  fromCanonicalEventRow,
  toCanonicalEventRow,
} from "../canonical-event-mapper";
import { canonicalEvents } from "../schema";
import { closeDb, getDb } from "../../src/lib/db/client";

/**
 * A fully populated event: every optional field present, and metadata carrying
 * nested objects, arrays, numbers, booleans and null — the shapes a jsonb column
 * would flatten to strings if the round trip were broken.
 *
 * `source` is an opaque discriminator, deliberately NOT a provider name: nothing
 * here may be named after a source (hard rule 1).
 */
const FULL_EVENT: CanonicalEvent = {
  id: "evt_01HQZX0000000000000000001",
  source: "fixture-source",
  externalId: "ext-4711",
  type: "issue_comment",
  title: 'A title with "quotes", a backslash \\ and a newline\nin it',
  // Byte-identical through the round trip: already canonical UTC with
  // millisecond precision, i.e. exactly what toISOString() emits. A non-canonical
  // offset is pinned separately in the normalisation test below.
  occurredAt: "2026-10-04T12:31:07.000Z",
  url: "https://example.invalid/events/ext-4711?a=1&b=two#frag",
  author: "some-actor",
  metadata: {
    nested: { deeply: { value: 42 } },
    list: [1, "two", false, null, { k: "v" }],
    number: 3.5,
    integer: 7,
    zero: 0,
    negative: -12,
    truthy: true,
    falsy: false,
    nothing: null,
    emptyString: "",
    emptyObject: {},
    emptyList: [],
    unicode: "emoji ✅ and ünïcödé",
  },
};

/** A minimal event, to prove absent optional fields stay absent after a read. */
const MINIMAL_EVENT: CanonicalEvent = {
  id: "evt_01HQZX0000000000000000002",
  source: "fixture-source",
  externalId: "ext-4712",
  type: "release",
  title: "Minimal",
  occurredAt: "2026-01-02T03:04:05.000Z",
  metadata: {},
};

const insertedIds: string[] = [];

async function insert(event: CanonicalEvent): Promise<void> {
  await getDb().insert(canonicalEvents).values(toCanonicalEventRow(event));
  insertedIds.push(event.id);
}

afterEach(async () => {
  for (const id of insertedIds.splice(0)) {
    await getDb().delete(canonicalEvents).where(eq(canonicalEvents.id, id));
  }
});

afterAll(async () => {
  await closeDb();
});

/** Forces both the object and its nested values through real JSON semantics. */
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The full Postgres error text for a rejected query.
 *
 * Drizzle's `error.message` is only `Failed query: <sql>` — the constraint name
 * that proves WHICH constraint fired lives on `error.cause` (the driver error).
 * Asserting on `error.message` would match nothing useful, so this walks the
 * cause chain. See `describeError` in src/lib/db/client.ts for the same finding.
 */
function postgresErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" -- ");
}

/** Asserts the insert is rejected, and that the named constraint is the reason. */
async function expectRejectedBy(
  insertPromise: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let error: unknown;
  try {
    await insertPromise;
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) {
    throw new Error(
      `Expected the insert to be rejected by ${constraintName}, but it succeeded.`,
    );
  }
  const text = postgresErrorText(error);
  if (!text.includes(constraintName)) {
    throw new Error(
      `Expected constraint ${constraintName} in the Postgres error, got: ${text}`,
    );
  }
}

describe("canonical_events persistence (type -> storage -> type)", () => {
  it("round-trips a fully populated event with every field deep-equal", async () => {
    await insert(FULL_EVENT);

    const rows = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, FULL_EVENT.id));

    expect(rows).toHaveLength(1);
    const read = fromCanonicalEventRow(rows[0]!);

    // Every field, compared after a JSON pass so nested metadata is checked by
    // value and type rather than by reference identity.
    expect(jsonRoundTrip(read)).toEqual(jsonRoundTrip(FULL_EVENT));

    // Spelled out so a regression names the field that broke.
    expect(read.id).toBe(FULL_EVENT.id);
    expect(read.source).toBe(FULL_EVENT.source);
    expect(read.externalId).toBe(FULL_EVENT.externalId);
    expect(read.type).toBe(FULL_EVENT.type);
    expect(read.title).toBe(FULL_EVENT.title);
    expect(read.url).toBe(FULL_EVENT.url);
    expect(read.author).toBe(FULL_EVENT.author);
  });

  it("preserves occurredAt as an ISO-8601 string, normalising offset to UTC", async () => {
    await insert(FULL_EVENT);

    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, FULL_EVENT.id));

    const read = fromCanonicalEventRow(row!);

    // A real Date in the driver, not a string and not a shifted instant.
    expect(row!.occurredAt).toBeInstanceOf(Date);
    expect(row!.occurredAt.toISOString()).toBe("2026-10-04T12:31:07.000Z");
    expect(read.occurredAt).toBe("2026-10-04T12:31:07.000Z");

    // And it survives a JSON pass byte-identically, which is the card's
    // requirement for this field (a Date or a shifted instant would both fail).
    expect(jsonRoundTrip(read.occurredAt)).toBe("2026-10-04T12:31:07.000Z");
    expect(typeof read.occurredAt).toBe("string");
  });

  it("normalises a non-UTC offset to the same instant in UTC", async () => {
    // A `timestamptz` column stores an instant, not a textual offset, so a
    // +02:00 input comes back as the equivalent UTC instant. This is the ONE
    // place the round trip is not byte-identical, and it is pinned explicitly so
    // the normalisation cannot drift or be mistaken for data loss.
    const offsetEvent: CanonicalEvent = {
      ...MINIMAL_EVENT,
      id: "evt_01HQZX0000000000000000006",
      externalId: "ext-4716",
      occurredAt: "2026-10-04T14:31:07+02:00",
    };
    await insert(offsetEvent);

    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, offsetEvent.id));

    expect(fromCanonicalEventRow(row!).occurredAt).toBe(
      "2026-10-04T12:31:07.000Z",
    );
    // Re-writing the normalised value is then stable.
    expect(
      toCanonicalEventRow({
        ...offsetEvent,
        occurredAt: "2026-10-04T12:31:07.000Z",
      }).occurredAt.toISOString(),
    ).toBe("2026-10-04T12:31:07.000Z");
  });

  it("pins occurredAt to a hand-written literal, not to its own round trip", async () => {
    // B27 finding 7: this test used to assert `second === first`, where `first`
    // is ALREADY the mapper's own `toISOString()` output — so it largely restated
    // that `toISOString()` is stable rather than checking what was persisted. The
    // expectation below is written out by hand, and the input is deliberately
    // NON-canonical (a `+02:00` offset with sub-second digits and no `Z`), so
    // the assertion can fail if the persisted instant is wrong.
    const nonCanonical: CanonicalEvent = {
      ...MINIMAL_EVENT,
      id: "evt_01HQZX0000000000000000007",
      externalId: "ext-4717",
      occurredAt: "2026-10-04T14:31:07.250+02:00",
    };
    await insert(nonCanonical);

    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, nonCanonical.id));

    // The instant, spelled out: 14:31:07.250 at +02:00 IS 12:31:07.250 UTC.
    const EXPECTED = "2026-10-04T12:31:07.250Z";
    expect(row!.occurredAt.toISOString()).toBe(EXPECTED);
    expect(fromCanonicalEventRow(row!).occurredAt).toBe(EXPECTED);

    // Feeding the canonical value back is idempotent — a SECOND, weaker
    // property, now stated after the strong one above rather than instead of it.
    const second = toCanonicalEventRow({
      ...nonCanonical,
      occurredAt: fromCanonicalEventRow(row!).occurredAt,
    }).occurredAt.toISOString();
    expect(second).toBe(EXPECTED);
  });

  it("preserves nested metadata types instead of flattening them to strings", async () => {
    await insert(FULL_EVENT);
    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, FULL_EVENT.id));

    const metadata = fromCanonicalEventRow(row!).metadata;

    expect(typeof metadata).toBe("object");
    expect(Array.isArray(metadata.list)).toBe(true);
    expect(metadata.nested).toEqual({ deeply: { value: 42 } });
    expect(typeof metadata.number).toBe("number");
    expect(metadata.number).toBe(3.5);
    expect(metadata.zero).toBe(0);
    expect(metadata.negative).toBe(-12);
    expect(metadata.truthy).toBe(true);
    expect(metadata.falsy).toBe(false);
    expect(metadata.nothing).toBeNull();
    expect(metadata.emptyString).toBe("");
    expect(metadata.emptyObject).toEqual({});
    expect(metadata.emptyList).toEqual([]);
    expect(metadata.unicode).toBe("emoji ✅ and ünïcödé");

    // The list's heterogeneous members keep their types, in order.
    const list = metadata.list as unknown[];
    expect(list).toEqual([1, "two", false, null, { k: "v" }]);
    expect(typeof list[0]).toBe("number");
    expect(typeof list[1]).toBe("string");
    expect(typeof list[2]).toBe("boolean");
    expect(list[3]).toBeNull();
  });

  it("stores metadata as jsonb, not text", async () => {
    await insert(FULL_EVENT);
    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, FULL_EVENT.id));

    // postgres-js parses jsonb into an object; a text column would yield a string.
    expect(typeof row!.metadata).toBe("object");
    expect(row!.metadata).not.toBeNull();
  });

  it("omits absent optional fields rather than inventing empty ones", async () => {
    await insert(MINIMAL_EVENT);
    const [row] = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, MINIMAL_EVENT.id));

    expect(row!.url).toBeNull();
    expect(row!.author).toBeNull();

    const read = fromCanonicalEventRow(row!);
    expect(read).toEqual(jsonRoundTrip(MINIMAL_EVENT));
    expect("url" in read).toBe(false);
    expect("author" in read).toBe(false);
  });

  it("defaults metadata to {} when the column is not supplied", async () => {
    const db = getDb();
    await db.insert(canonicalEvents).values({
      id: "evt_01HQZX0000000000000000003",
      source: "fixture-source",
      externalId: "ext-4713",
      type: "mention",
      title: "No metadata supplied",
      occurredAt: new Date("2026-05-05T05:05:05.000Z"),
    });
    insertedIds.push("evt_01HQZX0000000000000000003");

    const [row] = await db
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.id, "evt_01HQZX0000000000000000003"));

    // NOT NULL with a {} default, per the card: a NULL is indistinguishable
    // downstream from "no extra data", and the type says it is always present.
    expect(row!.metadata).toEqual({});
  });
});

describe("the mapper rejects timestamps it cannot persist faithfully (B27 f4/f5)", () => {
  // Both of these used to be accepted silently, producing a row whose
  // `occurred_at` was not the instant the caller supplied.
  const base = MINIMAL_EVENT;

  it("rejects an offset-less ISO value, whose instant would depend on the host TZ", () => {
    // `new Date("2026-10-04T12:31:07")` resolves in the PROCESS timezone, so
    // this string is not an instant at all — it is three different instants
    // depending on who parses it.
    expect(() =>
      toCanonicalEventRow({ ...base, occurredAt: "2026-10-04T12:31:07" }),
    ).toThrow(/explicit UTC offset/);
  });

  it("rejects sub-millisecond precision instead of truncating it", () => {
    expect(() =>
      toCanonicalEventRow({ ...base, occurredAt: "2026-10-04T12:31:07.0001Z" }),
    ).toThrow(/more precision than a Date can hold/);
  });

  it("accepts a representable fraction and an offset of either sign", () => {
    expect(
      toCanonicalEventRow({
        ...base,
        occurredAt: "2026-10-04T12:31:07.250Z",
      }).occurredAt.toISOString(),
    ).toBe("2026-10-04T12:31:07.250Z");
    expect(
      toCanonicalEventRow({
        ...base,
        occurredAt: "2026-10-04T14:31:07+02:00",
      }).occurredAt.toISOString(),
    ).toBe("2026-10-04T12:31:07.000Z");
  });
});

describe("canonical_events constraints are enforced by the database", () => {
  it("rejects a type outside CanonicalEventType", async () => {
    await expectRejectedBy(
      getDb()
        .insert(canonicalEvents)
        .values(
          toCanonicalEventRow({
            ...MINIMAL_EVENT,
            type: "not_a_real_type" as CanonicalEvent["type"],
          }),
        ),
      "canonical_events_type_check",
    );
  });

  it("rejects JSON null in metadata, which NOT NULL does not stop (B27 f2)", async () => {
    // `'null'::jsonb` is the JSON null VALUE, not SQL NULL, so the NOT NULL
    // column constraint accepts it — and it satisfies nothing `JsonObject`
    // promises. Only `jsonb_typeof(metadata) = 'object'` rejects it.
    await expectRejectedBy(
      getDb().execute(sql`
        INSERT INTO canonical_events
          (id, source, external_id, type, title, occurred_at, metadata)
        VALUES ('evt_json_null_meta', 'fixture-source', 'ext-json-null',
                'mention', 'json null metadata', now(), 'null'::jsonb)
      `),
      "canonical_events_metadata_is_object_check",
    );
  });

  it("rejects an array and a scalar in metadata (B27 f2)", async () => {
    // Each literal is spliced with `sql.raw` because a jsonb value must be
    // cast in SQL text; these three are fixed strings written here, never input.
    for (const [index, literal] of [
      "'[1,2,3]'",
      "'\"a string\"'",
      "'42'",
    ].entries()) {
      await expectRejectedBy(
        getDb().execute(sql`
          INSERT INTO canonical_events
            (id, source, external_id, type, title, occurred_at, metadata)
          VALUES (${`evt_nonobj_${index}`}, 'fixture-source',
                  ${`ext-nonobj-${index}`}, 'mention', 'non-object metadata',
                  now(), ${sql.raw(literal)}::jsonb)
        `),
        "canonical_events_metadata_is_object_check",
      );
    }
  });

  it("accepts a JSON object in metadata, including a nested one (B27 f2)", async () => {
    await insert({
      ...MINIMAL_EVENT,
      id: "evt_01HQZX0000000000000000008",
      externalId: "ext-4718",
      metadata: { a: 1, b: { c: [true, null] } },
    });
  });

  it("accepts every member of CanonicalEventType", async () => {
    for (const [index, type] of CANONICAL_EVENT_TYPES.entries()) {
      const event: CanonicalEvent = {
        ...MINIMAL_EVENT,
        id: `evt_type_${index}`,
        externalId: `ext-type-${index}`,
        type,
      };
      await insert(event);

      const [row] = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.id, event.id));
      expect(row!.type).toBe(type);
    }
  });

  it("rejects a duplicate (source, externalId)", async () => {
    await insert(MINIMAL_EVENT);

    // A different DevLoop id but the same natural key: the UNIQUE constraint is
    // what stops this, not the primary key.
    await expectRejectedBy(
      getDb()
        .insert(canonicalEvents)
        .values(
          toCanonicalEventRow({
            ...MINIMAL_EVENT,
            id: "evt_01HQZX0000000000000000009",
          }),
        ),
      "canonical_events_source_external_id_key",
    );
  });

  it("allows the same externalId under a different source", async () => {
    await insert(MINIMAL_EVENT);
    await insert({
      ...MINIMAL_EVENT,
      id: "evt_01HQZX0000000000000000004",
      source: "another-source",
    });

    const rows = await getDb()
      .select()
      .from(canonicalEvents)
      .where(eq(canonicalEvents.externalId, MINIMAL_EVENT.externalId));
    expect(rows).toHaveLength(2);
  });

  it("rejects a NULL in a NOT NULL column", async () => {
    // title is NOT NULL: proving the constraint is live in the other direction.
    await expectRejectedBy(
      getDb()
        .insert(canonicalEvents)
        .values({
          id: "evt_01HQZX0000000000000000005",
          source: "fixture-source",
          externalId: "ext-4715",
          type: "release",
          title: null as unknown as string,
          occurredAt: new Date("2026-05-05T05:05:05.000Z"),
        }),
      'null value in column "title"',
    );
  });
});
