import { randomBytes } from "node:crypto";

/** Crockford base32, the ULID alphabet (no I, L, O, U). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits as 16 base32 chars.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

function incrementBase32(s: string): string {
  const chars = s.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = CROCKFORD.indexOf(chars[i] as string);
    if (idx < 31) {
      chars[i] = CROCKFORD[idx + 1] as string;
      return chars.join("");
    }
    chars[i] = "0";
  }
  throw new Error("ULID random part overflowed");
}

export interface UlidFactoryOptions {
  readonly now?: () => number;
  readonly random?: (n: number) => Uint8Array;
}

/** A monotonic ULID factory: ids from one factory always sort in creation order. */
export function createUlidFactory(o: UlidFactoryOptions = {}): () => string {
  const now = o.now ?? Date.now;
  const random = o.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom = "";
  return () => {
    const t = Math.max(now(), lastTime);
    if (t === lastTime) {
      lastRandom = incrementBase32(lastRandom);
    } else {
      lastTime = t;
      lastRandom = encodeRandom(random(10));
    }
    return encodeTime(t) + lastRandom;
  };
}

export const ulid: () => string = createUlidFactory();

export function isUlid(s: unknown): s is string {
  return typeof s === "string" && ULID_RE.test(s);
}

/** A new item id: a lowercase ULID, so it is a valid address segment and sorts by creation. */
export function newItemId(next: () => string = ulid): string {
  return next().toLowerCase();
}
