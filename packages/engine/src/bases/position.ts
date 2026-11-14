// Manual row order by fractional keys: inserting between two rows writes only the new one.
// A port of the algorithm of Rocicorp's `fractional-indexing` (CC0-1.0, https://github.com/rocicorp/fractional-indexing),
// with base 62 digits. The order is byte order: in Postgres, `ORDER BY position COLLATE "C"`.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0] as string;
const SMALLEST_INT = `A${ZERO.repeat(26)}`;

export class PositionError extends Error {}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new PositionError(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new PositionError("trailing zero");
  if (b) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0] as string) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))] as string;
  if (b && b.length > 1) return b.slice(0, 1);
  return (DIGITS[da] as string) + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new PositionError(`invalid head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0] ?? "");
  if (len > key.length) throw new PositionError(`invalid key: ${key}`);
  return key.slice(0, len);
}

/** A well-formed key (the server rejects keys that are not). */
export function isPosition(key: string): boolean {
  try {
    if (!/^[0-9A-Za-z]{2,1024}$/.test(key) || key === SMALLEST_INT) return false;
    const i = integerPart(key);
    return key.slice(i.length).slice(-1) !== ZERO;
  } catch {
    return false;
  }
}

function increment(x: string): string | null {
  const [head, ...digs] = x.split("") as [string, ...string[]];
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i] as string) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d] as string;
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(ZERO);
  else digs.pop();
  return h + digs.join("");
}

function decrement(x: string): string | null {
  const [head, ...digs] = x.split("") as [string, ...string[]];
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i] as string) - 1;
    if (d === -1) digs[i] = DIGITS.slice(-1);
    else {
      digs[i] = DIGITS[d] as string;
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return `Z${DIGITS.slice(-1)}`;
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(DIGITS.slice(-1));
  else digs.pop();
  return h + digs.join("");
}

/** A key strictly between `a` and `b` (null = no bound on that side). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isPosition(a)) throw new PositionError(`invalid key: ${a}`);
  if (b !== null && !isPosition(b)) throw new PositionError(`invalid key: ${b}`);
  if (a !== null && b !== null && a >= b) throw new PositionError(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const r = decrement(ib);
    if (r === null) throw new PositionError("cannot decrement");
    return r;
  }
  if (b === null) {
    const ia = integerPart(a);
    const i = increment(ia);
    return i === null ? ia + midpoint(a.slice(ia.length), null) : i;
  }
  const ia = integerPart(a);
  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(a.slice(ia.length), b.slice(ib.length));
  const i = increment(ia);
  if (i === null) throw new PositionError("cannot increment");
  return i < b ? i : ia + midpoint(a.slice(ia.length), null);
}

/** `n` ordered keys between `a` and `b`, short even for a large n (CSV import). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(c, b);
      out.push(c);
    }
    return out;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(a, c);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}
