import { randomBytes } from "node:crypto";

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48 bit Unix milliseconds, then a 12 bit counter, then random.
 * The counter keeps ids from one process strictly ascending within a millisecond,
 * so primary keys insert at the end of the index.
 */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) {
      ms++;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMs = ms;

  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
