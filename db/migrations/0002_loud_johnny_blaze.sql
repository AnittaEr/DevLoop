-- WHY THE FIRST STATEMENT IS HERE (B27 review, defect 1).
--
-- `0001_parched_talon.sql` declares `"metadata" jsonb DEFAULT '{}'::jsonb NOT
-- NULL` with NO shape CHECK. `NOT NULL` rejects SQL NULL, not the JSON value
-- `null`, and it says nothing about an array or a bare scalar -- so a row
-- holding `"metadata": [1,2]` was perfectly legal under 0001.
--
-- `ADD CONSTRAINT ... CHECK` VALIDATES EXISTING ROWS. Applying this migration
-- as a bare ALTER TABLE therefore fails on any database that already holds such
-- a row, with an error that names a constraint and not a cause:
--
--   ERROR: check constraint "canonical_events_metadata_is_object_check" of
--   relation "canonical_events" is violated by some row
--
-- That bricks `db:migrate` for every developer whose database predates this
-- migration. MEASURED, not hypothesised: applied 0000+0001, inserted
-- `metadata = '[1,2]'::jsonb` (the insert SUCCEEDED), then applied this file ->
-- exit 1 with the error above. The round-trip suite cannot catch this, because
-- it only ever migrates a FRESH database -- which is why it reported 20/20
-- green while the upgrade path was broken.
--
-- So the legacy rows are remediated HERE, in the same transaction that adds the
-- constraint (drizzle's postgres migrator wraps every migration in one
-- transaction: `pg-core/dialect.js` -> `session.transaction`), so the two can
-- never disagree -- either both land or neither does.
--
-- REPAIR, NOT DELETE. The offending value is wrapped under a single reserved
-- key rather than overwritten or dropped:
--
--   - Overwriting with '{}' would silently destroy whatever the source put
--     there, and the row would then look like a legitimate empty-metadata event.
--   - Deleting the row would destroy the event itself, which is the one thing a
--     persistence migration must never do to a user's data.
--
-- Wrapping keeps the row AND its original payload, visibly marked as
-- remediated, so a human can inspect and reverse it. `_devloop_legacy_non_object`
-- is namespaced and documented here; the writer in
-- `db/canonical-event-mapper.ts` never emits it, so it cannot collide with a
-- real metadata key.
--
-- The NOTICE is not decoration: a silent repair of user data is exactly the kind
-- of thing that must be visible in the migrate output rather than discovered
-- later. `IS DISTINCT FROM` (not `<>`) is used so a hypothetical NULL would also
-- be remediated rather than skipped by three-valued logic.
DO $$
DECLARE
  remediated bigint;
BEGIN
  UPDATE "canonical_events"
     SET "metadata" = jsonb_build_object('_devloop_legacy_non_object', "metadata")
   WHERE jsonb_typeof("metadata") IS DISTINCT FROM 'object';

  GET DIAGNOSTICS remediated = ROW_COUNT;
  IF remediated > 0 THEN
    RAISE NOTICE 'canonical_events: remediated % pre-existing row(s) whose metadata was not a JSON object, wrapping the original value under "_devloop_legacy_non_object" so the shape CHECK could be added', remediated;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "canonical_events" ADD CONSTRAINT "canonical_events_metadata_is_object_check" CHECK (jsonb_typeof("metadata") = 'object');