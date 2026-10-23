/**
 * WHY THIS RULE EXISTS — R145, and it is NOT the same defect as its ticket says.
 *
 * `db/canonical-event-mapper.ts` is the type <-> storage boundary: it turns a
 * `CanonicalEvent` into a `canonical_events` row and back. The write path
 * (`toCanonicalEventRow`) clones `event.metadata` and hands it to a `jsonb`
 * column. That assignment WAS written `structuredClone(event.metadata) as
 * JsonObject`; this rule's own commit removes the cast, so the tree today reads
 * `structuredClone(event.metadata)`. The paragraphs below describe the state
 * that motivated the rule, and say so in past tense deliberately — a
 * specification that keeps describing a defect as present stops being true the
 * moment the defect is fixed, which is the whole point of fixing it.
 *
 * The cast was not load-bearing for the type checker, and this was MEASURED on
 * this tree at `e780063`, not assumed:
 *
 *   - remove ` as JsonObject` from that line -> `bun run typecheck` exit 0.
 *   - replace the whole expression with `"nonsense" as unknown as JsonObject`
 *     -> `bun run typecheck` exit 0. The value is a string. The column is
 *     `jsonb`. `tsc` is satisfied either way.
 *
 * So an assertion sits on the one value that must be provably JSON-safe before
 * it reaches Postgres, and no gate in this repository can see it. That is the
 * whole defect: an assertion that erases a check nothing else performs. It is
 * the same genre as the plugin-boundary entries in 30-risk-register.md — a
 * property held by an argument in a PR description rather than by a machine.
 *
 * WHY THE SCOPE IS AN AST SELECTOR AND NOT A TEXT SEARCH.
 *
 * The obvious cheap implementation is grep the source for `as JsonObject`. It
 * is wrong in a way that fails immediately and loudly here: this very file, the
 * config, and the mapper's own doc comments all NAME the cast. A text rule
 * fires inside a comment and inside a string literal — including the negative
 * control that proves the rule works. It would have to grow a comment-stripping
 * heuristic to avoid flagging its own documentation, and that heuristic is a new
 * way to be wrong. Matching the `TSAsExpression` / `TSTypeAssertion` NODE asks
 * the parser what is code and what is prose, so the rule can describe the
 * property and can safely be discussed in prose.
 *
 * WHY THE WRITE PATH ONLY, AND WHY THAT IS NOT MEASUREMENT SHOPPING.
 *
 * The same file USED to have a second cast, on the read path:
 * `metadata: (row.metadata ?? {}) as JsonObject`. Batch 12 removed it, so
 * `fromCanonicalEventRow` reads `metadata: row.metadata` today — the column is
 * typed as `CanonicalEventType` and CHECKed by the database. This rule was
 * never pointed at that line, and it should not be pointed at its replacement:
 * `tsc` already held it. Deleting the cast yields
 *
 *   TS2322: Type '{}' is not assignable to type 'JsonObject'.
 *     Index signature for type 'string' is missing in type '{}'.
 *
 * — `{}` is not a `JsonObject`, so the read path is refused by the type checker
 * on its own. A lint rule defending a property the compiler already defends is
 * noise that makes the real one harder to see. The argument is kept here in
 * past tense because it is still load-bearing: it is what stops a future author
 * widening this rule to re-defend read-path narrowing that `tsc` already
 * refuses to give up.
 *
 * SCOPE. Registered on `db/**` and `src/**` — the whole codebase, in practice,
 * minus config and e2e. `src/app/**` is included deliberately: unlike the plugin
 * boundary (which is about core NOT reaching out), this property is about not
 * laundering a value into a storage column, and a route handler or server
 * action writing to the database is exactly where that would reappear.
 *
 * THE ALLOWLIST, AND WHY IT IS NOW EMPTY (history, kept deliberately).
 *
 * At the base `e780063` the tree carried TWO occurrences of the denied shape,
 * both in `db/canonical-event-mapper.ts` (write path line 39, read path line
 * 63), both predating this rule. They were individually justified in
 * `eslint.config.mjs` and pinned by LINE rather than by file, on the reasoning
 * that the property belongs to those two lines specifically: a third assertion
 * anywhere in the repo, or a second one in either function, is an error, where
 * a file-level allowlist would silently legalise every future cast in the one
 * file this defect has ever been observed in.
 *
 * That reasoning was right about line pinning and wrong about pinning AT ALL.
 * The write-path cast was removed by this card (narrowing the value, not
 * silencing the rule — `event.metadata` is already `JsonObject` and
 * `structuredClone<T>(value: T): T` preserves `T`, so there was nothing to
 * replace the assertion with), and batch 12 had already removed the read-path
 * cast. So `allow` is now `[]` and there is no exception in force.
 *
 * The measured reason not to reach for an allowlist again: those entries were
 * pinned to `db/canonical-event-mapper.ts:39` and `:63`, and the moment batch
 * 12 merged the write-path cast moved to line 135 and the read-path cast
 * vanished — both entries went stale in one integration and `bun run lint`
 * failed on `main` with three errors (two stale, one real at 135). Line pinning
 * buys precision and pays in staleness; an empty allowlist is the strongest
 * statement of the property and cannot rot.
 *
 * If you add an entry: it goes in `allow` as `file:line`, and the rule's own
 * `staleAllowlistEntry` message (reported unconditionally, once per file) will
 * name it back to you the moment the line it names stops being an assertion.
 * `meta.schema` accepts `allow` ONLY — there is no `unusedAllowlistEntries`
 * option, and passing one is a schema validation crash (exit 2), not a lint
 * error.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The type names this rule denies an assertion TO.
 *
 * `Json`, `JsonObject` and `JsonValue` are this repo's own, declared in
 * `src/core/events/canonical-event.ts`. `PgJsonb` is the Drizzle column type
 * behind `jsonb("metadata")` in `db/schema.ts`; it is named here because the
 * ticket calls for Drizzle JSON types and because an assertion straight to the
 * column type is the same laundering with one fewer step.
 *
 * Matched as the LAST segment of the type reference, so `drizzle.PgJsonb`,
 * `CanonicalEvent["metadata"]`-adjacent spellings and a future
 * `db.JsonObject` are all caught without this list growing per import site. The
 * three local names are the ones the codebase actually uses — verified by
 * grep, not guessed; see the config comment for the measurement.
 */
const DENIED_TYPE_NAMES = new Set([
  "Json",
  "JsonObject",
  "JsonValue",
  "PgJsonb",
]);

/** `file.ts:12` -> a comparable key. Line numbers are 1-based in both forms. */
function allowlistKey(filename, line) {
  const relative = path.relative(ROOT_DIR, path.resolve(filename));
  return `${relative.split(path.sep).join("/")}:${line}`;
}

/**
 * The trailing identifier of a type reference, or `null`.
 *
 * `TSQualifiedName` walks `.left` until it reaches the rightmost identifier, so
 * `drizzle.PgJsonb` yields `PgJsonb`. Anything that is not a plain named
 * reference — an inline object type, a union, an indexed access — returns `null`
 * and is left alone: this rule denies named JSON types, and a type whose text
 * merely contains the word "Json" is not one of them.
 */
function trailingTypeName(typeAnnotation) {
  if (!typeAnnotation || typeAnnotation.type !== "TSTypeReference") return null;
  let name = typeAnnotation.typeName;
  while (name && name.type === "TSQualifiedName") name = name.right;
  if (!name || name.type !== "Identifier") return null;
  return name.name;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Deny asserting a value to a JSON type (JsonObject/Json/JsonValue/PgJsonb) where no type check would have caught the laundering.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      assert:
        'Unchecked assertion to `{{name}}`. `tsc` accepts a value asserted into this type even when it is not one (measured: `structuredClone(x) as JsonObject` and `"nonsense" as unknown as JsonObject` both typecheck), so this assertion hides the only check that a jsonb-bound value is JSON-safe. Narrow the value at the boundary instead of asserting it.',
      staleAllowlistEntry:
        "`{{entry}}` is an allowlist entry for the no-json-assert rule, but nothing on that line is an assertion to a JSON type any more. Delete the stale entry; keeping it would let the NEXT assertion on a shifted line through unnoticed.",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowed = new Set(options.allow ?? []);
    // Reported once per file, after the walk, so a stale entry is a message
    // rather than silence. Reported unconditionally: whether or not this file
    // has any offending assertion, an entry naming a line in it is wrong.
    const used = new Set();

    function check(node, typeAnnotation) {
      const name = trailingTypeName(typeAnnotation);
      if (name === null || !DENIED_TYPE_NAMES.has(name)) return;
      const key = allowlistKey(context.filename, node.loc.start.line);
      if (allowed.has(key)) {
        used.add(key);
        return;
      }
      context.report({ node, messageId: "assert", data: { name } });
    }

    return {
      // `x as T` and `<T>x`. Both parse to an assertion; only one of them is
      // valid TSX-free TypeScript, but both are the shape and a `.tsx` file can
      // legitimately carry neither — checking both costs one visitor and
      // removes "which syntax did the author use" as a bypass.
      TSAsExpression: (node) => check(node, node.typeAnnotation),
      TSTypeAssertion: (node) => check(node, node.typeAnnotation),
      "Program:exit": () => {
        for (const entry of allowed) {
          if (used.has(entry)) continue;
          const file = entry.slice(0, entry.lastIndexOf(":"));
          if (
            path.relative(ROOT_DIR, path.resolve(context.filename)) !== file
          ) {
            continue;
          }
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "staleAllowlistEntry",
            data: { entry },
          });
        }
      },
    };
  },
};

/** Flat-config plugin. Register with `plugins: { "no-json-assert": … }`. */
export const noJsonAssertPlugin = {
  rules: {
    "no-assert-to-json-type": rule,
  },
};

/** The fully-qualified rule id as configured in `eslint.config.mjs`. */
export const RULE_ID = "no-json-assert/no-assert-to-json-type";

/** Exported for the meta test, which asserts the denied vocabulary. */
export { DENIED_TYPE_NAMES };
