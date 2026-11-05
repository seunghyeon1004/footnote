/** NEAR account id validation (same grammar the NEAR protocol uses for named and implicit accounts). */
const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

export function isNearAccountId(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (v.length < 2 || v.length > 64) return false;
  return IMPLICIT.test(v) || NAMED.test(v);
}

export const isImplicitAccount = (s: string) => IMPLICIT.test(s);

/** Normalise a creator declaration: trims, lower-cases, rejects anything that is not a plain account id. */
export function parseNearAccount(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const a = v.trim().toLowerCase();
  return isNearAccountId(a) ? a : null;
}
