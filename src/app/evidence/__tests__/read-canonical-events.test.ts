/**
 * Tests for the evidence read seam (T20).
 *
 * IN ITS OWN FILE, AND THAT IS LOAD-BEARING. `evidence-page.test.tsx` has to
 * MOCK this module so it can assert the protected page never reaches the
 * database when the guard refuses — and a `vi.mock` is file-scoped, so a test
 * for the real reader living in that file would silently be testing the mock.
 * That was measured, not assumed: the first version of these two assertions sat
 * beside the page tests and "passed" by returning the mock's canned single event,
 * which proved nothing about the reader at all.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "@/core/events/canonical-event";

import { readCanonicalEvents } from "../read-canonical-events";

/**
 * A SELECT row, built to mirror what Drizzle returns.
 *
 * `occurredAt` is a `Date` here and an ISO-8601 string on the domain type — that
 * difference IS the type↔storage boundary, and it is the reason these rows are
 * not typed as `CanonicalEvent[]`.
 */
function toRow(event: CanonicalEvent) {
  return {
    id: event.id,
    source: event.source,
    externalId: event.externalId,
    type: event.type,
    title: event.title,
    occurredAt: new Date(event.occurredAt),
    url: event.url ?? null,
    author: event.author ?? null,
    metadata: event.metadata,
  };
}

const FIRST: CanonicalEvent = {
  id: "evt_seam_0001",
  source: "local-demo-source",
  externalId: "seam-1",
  type: "issue",
  title: "First recorded event",
  occurredAt: "2026-01-15T10:00:00.000Z",
  metadata: {},
};

const SECOND: CanonicalEvent = {
  ...FIRST,
  id: "evt_seam_0002",
  externalId: "seam-2",
  occurredAt: "2026-02-20T10:00:00.000Z",
};

describe("readCanonicalEvents", () => {
  it("converts every row through the mapper, in the order the database returned", async () => {
    const result = await readCanonicalEvents({
      select: () => ({ from: async () => [toRow(FIRST), toRow(SECOND)] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error("expected ok");
    expect(result.events.map((event) => event.id)).toEqual([
      "evt_seam_0001",
      "evt_seam_0002",
    ]);
    // The mapper's conversion is what makes `occurredAt` renderable at all: a
    // `Date` from the row becomes an ISO-8601 string on the domain type, and a
    // seam typed as `CanonicalEvent[]` would have let a caller skip that step.
    expect(result.events[0]?.occurredAt).toBe("2026-01-15T10:00:00.000Z");
    expect(result.events[0]?.title).toBe("First recorded event");
  });

  it("reports an empty table as success with zero events, not as a refusal", async () => {
    const result = await readCanonicalEvents({
      select: () => ({ from: async () => [] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error("expected ok");
    expect(result.events).toEqual([]);
  });

  it("reports an unreachable database without echoing the driver message", async () => {
    const result = await readCanonicalEvents({
      select: () => ({
        from: async () => {
          throw new Error(
            "connect ECONNREFUSED 127.0.0.1:5432 password authentication failed for user devloop",
          );
        },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected a refusal");
    expect(result.outcome).toBe("database_unavailable");
    // The driver's message can name a host, a role and a failure mode; none of
    // it belongs on a rendered page, and a connection string must never leak.
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("password");
    // It names the VARIABLE the operator must set, as the auth guard does.
    expect(result.message).toContain("DATABASE_URL");
    expect(result.fetched).toBe(0);
  });
});
