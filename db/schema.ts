/**
 * Drizzle schema root for DevLoop.
 *
 * SCOPE (T5): this file owns persistence MECHANICS only — it proves the schema ->
 * migration -> client path works end to end. It deliberately contains NO
 * canonical-events table and no provider-specific (GitHub) columns: that shape is
 * owned by T3 (`t_4056bdb5`) and must match the core domain type that card
 * defines. Adding such a table here would be guessing a contract another card
 * owns.
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Generic key/value application metadata store.
 *
 * Infrastructure only: used by the migration/DX machinery, carries no product or
 * provider semantics.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppMetaRow = typeof appMeta.$inferSelect;
export type NewAppMetaRow = typeof appMeta.$inferInsert;
