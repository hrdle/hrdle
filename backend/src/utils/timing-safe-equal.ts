import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secrets (HMAC signatures, server
 * password). A plain `a === b` short-circuits on the first differing byte,
 * leaking how many leading bytes matched via timing.
 *
 * Both inputs are SHA-256 hashed first so the comparison runs over
 * fixed-length (32-byte) digests: timingSafeEqual requires equal-length
 * buffers, and hashing also avoids leaking the secret's length when the
 * inputs differ in size.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
