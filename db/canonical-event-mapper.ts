/**
 * Row <-> `CanonicalEvent` mapping for `canonical_events`.
 *
 * This is the *type <-> storage* boundary, not the *provider -> type* boundary:
 * turning a source's payload into a `CanonicalEvent` belongs to the plugin layer
 * (T106) and no provider vocabulary may appear here or in the columns this maps.
 *
 * `occurredAt` is the only lossy-looking field. It is an ISO-8601 string on the
 * type but a `timestamptz` in Postgres, so it is parsed on write and
 * re-serialised on read. `toISOString()` always renders UTC with millisecond
 * precision and a trailing `Z`, so a round trip is exact for any instant the type
 * can express, but an input with a different textual form (e.g. `+02:00` offset,
 * or omitted milliseconds) is normalised rather than preserved byte-for-byte. The
 * round-trip test pins that normalisation explicitly so it cannot drift.
 */

import type {
  CanonicalEvent,
  JsonObject,
} from "../src/core/events/canonical-event";
import type { NewCanonicalEventRow } from "./schema";

/** Converts a `CanonicalEvent` into its insertable row shape. */
export function toCanonicalEventRow(
  event: CanonicalEvent,
): NewCanonicalEventRow {
  return {
    id: event.id,
    source: event.source,
    externalId: event.externalId,
    type: event.type,
    title: event.title,
    // Parsed to a Date; Drizzle/bind hands a Date to Postgres for timestamptz.
    occurredAt: new Date(event.occurredAt),
    url: event.url ?? null,
    author: event.author ?? null,
    // Structured-cloned so a caller mutating the event afterwards cannot change
    // the row (and so the value is provably JSON-safe before it reaches jsonb).
    metadata: structuredClone(event.metadata) as JsonObject,
  };
}

/**
 * Converts a selected row back into a `CanonicalEvent`.
 *
 * The optional fields are omitted (not set to undefined) when absent, so the
 * result deep-equals an input that omitted them.
 */
export function fromCanonicalEventRow(
  row: NewCanonicalEventRow,
): CanonicalEvent {
  // Built with spreads rather than post-assignment: CanonicalEvent's fields are
  // readonly, so the optional keys must be included at construction time (and
  // omitted entirely when absent, so the result deep-equals an input that
  // omitted them).
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    type: row.type as CanonicalEvent["type"],
    title: row.title,
    occurredAt: row.occurredAt.toISOString(),
    metadata: (row.metadata ?? {}) as JsonObject,
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.author !== null ? { author: row.author } : {}),
  };
}
