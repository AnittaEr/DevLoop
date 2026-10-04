CREATE TABLE "canonical_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"url" text,
	"author" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "canonical_events_source_external_id_key" UNIQUE("source","external_id"),
	CONSTRAINT "canonical_events_type_check" CHECK ("type" in ('issue', 'change_proposal', 'issue_comment', 'change_review', 'release', 'mention'))
);
--> statement-breakpoint
CREATE INDEX "canonical_events_occurred_at_idx" ON "canonical_events" USING btree ("occurred_at");