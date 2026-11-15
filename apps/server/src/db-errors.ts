/** SQLSTATE code of the error (Drizzle wraps the driver error in `cause`). */
export function pgCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && typeof cur === "object" && cur !== null; i++) {
    if ("code" in cur && typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code;
    cur = "cause" in cur ? cur.cause : null;
  }
  return null;
}

export const isUniqueViolation = (err: unknown) => pgCode(err) === "23505";
