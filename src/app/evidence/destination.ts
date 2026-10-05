/**
 * The two page routes, named once (T20).
 *
 * WHY A SEPARATE MODULE. `/evidence` refuses by redirecting to `/sign-in`, and
 * `/sign-in` sends an already-signed-in visitor to `/evidence`. Written inline
 * in both pages that is two string literals that must agree; written as
 * `"/sign-in/page.tsx" -> "/evidence"` each page would have to import the other's
 * page module, and a route module importing another route module is both
 * awkward and a cycle waiting to form the moment either side grows an import.
 *
 * So the constants live here, in neither route, and both import them. There is
 * no runtime dependency here at all — two string constants — so nothing about
 * auth, the guard, or the database is reachable through this module.
 */

export const SIGN_IN_ROUTE = "/sign-in";

/** Where a signed-in visitor is sent instead of being shown the sign-in form. */
export const SIGNED_IN_DESTINATION = "/evidence";

/** Where an unauthenticated visitor to the evidence page is redirected. */
export const SIGNED_OUT_DESTINATION = SIGN_IN_ROUTE;
