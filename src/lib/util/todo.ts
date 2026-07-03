/**
 * Scaffold stub helper. Every not-yet-implemented body funnels through here so
 * the repo typechecks from commit 1 (PLAN §4): `TODO(...)` returns `never`
 * (assignable to any declared return type) and accepts the function's args so
 * `noUnusedParameters` stays happy without renaming the frozen-contract params.
 *
 * The Build phase replaces `TODO(...)` call sites with real implementations.
 */
export function TODO(..._args: unknown[]): never {
  throw new Error("TODO: not implemented (scaffold stub)");
}
