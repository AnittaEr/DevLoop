/**
 * This provider's access-token shape, declared on the provider's side of the
 * plugin boundary.
 *
 * `src/core/credentials/provider.ts` states the SHAPE of a token — it has a
 * prefix and comes from a named environment variable — but deliberately not
 * WHICH provider's shape it is. That half is vendor knowledge, so it lives
 * here, beside the plugin that owns the wire format, and the composition root
 * passes it into `createCredentialProvider("env", { profile })`.
 *
 * It lives in a non-test module because the composition root is production
 * code: a test fixture cannot be the only declaration, or the profile would be
 * unavailable exactly where a real token has to be validated. The test fixture
 * `src/plugins/github/__tests__/fixtures.ts` re-exports this constant rather
 * than restating it, so there is one declaration and no drift.
 *
 * `envVar` is a NAME, never a value, and is never read here.
 */

import {
  assertValidTokenProfile,
  type TokenProfile,
} from "@/core/credentials/provider";

/**
 * The name of the environment variable an operator sets, i.e. the one
 * `.env.example` documents. NOT `GITHUB_TOKEN`, which is what the plugin's
 * test fixture used to say: a test-only name that the fixture never reads (it
 * injects its own reader) and that no operator was ever told about. Carrying it
 * here produced `token_absent` at runtime for anyone who had followed the
 * documentation exactly, with every gate green.
 *
 * `src/plugins/github/__tests__/token-profile.test.ts` pins this against
 * `.env.example` itself, so the two cannot drift apart again silently.
 */
const PROFILE = {
  prefix: "github_pat_",
  envVar: "GITHUB_FINE_GRAINED_PAT",
} as const satisfies TokenProfile;

/**
 * The token profile for this provider's access tokens.
 *
 * Validated through core's own constructor check at module load, so an
 * unusable profile fails here rather than silently producing a provider that
 * accepts any string.
 */
export const GITHUB_TOKEN_PROFILE: TokenProfile =
  assertValidTokenProfile(PROFILE);
