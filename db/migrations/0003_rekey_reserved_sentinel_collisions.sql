-- WHY THIS MIGRATION EXISTS (B42).
--
-- `0002_loud_johnny_blaze.sql` reserves the top-level metadata key
-- `_devloop_legacy_non_object`: it wraps the original value of any pre-existing
-- row whose metadata was NOT a JSON object under exactly that key, so the
-- remediation stays visible and reversible. The writer in
-- `db/canonical-event-mapper.ts` refuses to EMIT that key at the top level
-- (`RESERVED_METADATA_KEYS`), because a row carrying it cannot be told apart
-- from a remediated one.
--
-- That reservation collides with a plugin that used the same name as REAL data
-- BEFORE 0002 was written. Such a row's metadata IS a genuine JSON object, so
-- 0002's remediation
--
--   WHERE jsonb_typeof("metadata") IS DISTINCT FROM 'object'
--
-- does not match it: the row is left exactly as the plugin wrote it. From then
-- on the event can NEVER CONVERGE again — every future write of it hits the
-- reserved-key refusal in `toCanonicalEventRow`, so the source retries forever a
-- payload the writer will never accept. MEASURED, not hypothesised: with
-- `{"_devloop_legacy_non_object": {"real":"plugin data"}}` present on a
-- 0000+0001 database, 0002 applied cleanly, left the row byte-identical, and
-- `toCanonicalEventRow` then threw for it.
--
-- THE CHOICE: RE-KEY, DO NOT DELETE (the reversible option). Deleting would
-- destroy the user's event and its payload — the one thing a persistence
-- migration must never do — and would be irreversible: nothing would record that
-- the plugin ever used that name. Re-keying renames exactly one key of exactly
-- the rows that are provably NOT the remediation shape, leaves every other row
-- byte-identical, and is reversible by renaming the key back, since the mapping
-- is 1:1 and the old name is recorded in the new key's own text.
--
-- THE TARGET KEY. `_devloop_rekeyed_from_reserved_legacy_non_object` is a NEW
-- name, deliberately outside the writer's reserved namespace: a re-keyed row must
-- round-trip through `toCanonicalEventRow`, and a name that the writer refused
-- would reproduce the very defect this migration repairs. It is not added to
-- `RESERVED_METADATA_KEYS`, because the reserved namespace is exactly "shapes
-- 0002 can produce" and this key is not one of them.
--
-- HOW A COLLISION IS TOLD APART FROM THE REMEDIATION. 0002 only ever wrapped a
-- NON-object, so a remediated row is EXACTLY one key, whose value is not a JSON
-- object. A row is therefore provably a collision when it carries the reserved
-- key AND either has another key beside it, or the reserved key's own value IS a
-- JSON object — a shape 0002 could not have produced.
--
-- THE ONE CASE LEFT ALONE, STATED PLAINLY. A row that is nothing but
-- `{"_devloop_legacy_non_object": <non-object>}` is BYTE-INDISTINGUISHABLE from
-- the remediation 0002 produced. Nothing in the row records which writer made
-- it, so re-keying it would corrupt real remediated data while leaving it alone
-- leaves it unwritable. This migration does not touch it: the conservative
-- branch is the only honest one, and the ambiguity is reported rather than
-- resolved by guessing. A plugin in that position must rename the key in its own
-- payloads — the writer's error message already tells it to.
--
-- WHY A NEW MIGRATION AND NOT AN EDIT TO 0002. 0002 is shipped and applied.
-- Rewriting it would silently change history for every database that already ran
-- it: such a database would never receive the repair while a fresh one would.
-- So the fix is appended as 0003.
--
-- IDEMPOTENCE, TWICE OVER, WHICH IS THE PROPERTY THAT MATTERS. Re-running the
-- repair is a no-op because it only matches rows that still carry the OLD key,
-- and a row the repair has already touched no longer does. Run twice, the
-- colliding row is re-keyed on the first run and byte-identical on the second;
-- a correctly remediated row is byte-identical on both. Nothing here depends on
-- the migration being run once.
--
-- THE NOTICES are not decoration, for the same reason 0002's is: a silent
-- rewrite of user data is exactly what must be visible in the migrate output.
DO $$
DECLARE
  carrying  bigint;
  rekeyed  bigint;
  ambiguous bigint;
BEGIN
  SELECT count(*)
    INTO carrying
    FROM "canonical_events"
   WHERE jsonb_typeof("metadata") = 'object'
     AND "metadata" ? '_devloop_legacy_non_object';

  -- Nothing carries the key, so there is nothing to repair and nothing to say.
  IF carrying = 0 THEN
    RETURN;
  END IF;

  UPDATE "canonical_events"
     SET "metadata" =
           ("metadata" - '_devloop_legacy_non_object')
           || jsonb_build_object(
                '_devloop_rekeyed_from_reserved_legacy_non_object',
                "metadata" -> '_devloop_legacy_non_object'
              )
   WHERE jsonb_typeof("metadata") = 'object'
     AND "metadata" ? '_devloop_legacy_non_object'
     AND NOT (
           ("metadata" - '_devloop_legacy_non_object') = '{}'::jsonb
           AND jsonb_typeof("metadata" -> '_devloop_legacy_non_object')
               IS DISTINCT FROM 'object'
         );

  GET DIAGNOSTICS rekeyed = ROW_COUNT;
  ambiguous := carrying - rekeyed;

  RAISE NOTICE 'canonical_events: re-keyed % pre-existing row(s) whose metadata used "_devloop_legacy_non_object" as real plugin data, renaming that key to "_devloop_rekeyed_from_reserved_legacy_non_object" so the writer stops refusing them permanently. % further row(s) carry the reserved key in exactly the remediated shape and were deliberately left untouched, because that shape is indistinguishable from what 0002 itself produced.',
    rekeyed, ambiguous;

  IF ambiguous > 0 THEN
    RAISE WARNING 'canonical_events: % row(s) carry "_devloop_legacy_non_object" as their ONLY key with a non-object value — the exact shape 0002 produced, so they cannot be told apart from a remediated row and were not rewritten. If such a row is plugin data rather than a remediation, rename the key in the source payloads; the writer will report it again on every write.',
      ambiguous;
  END IF;
END $$;