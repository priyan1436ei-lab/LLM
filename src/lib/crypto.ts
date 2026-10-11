import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Credential hashing and opaque token generation (spec §76, §77).
 *
 * Credentials are hashed with scrypt, a memory-hard KDF available in Node's standard
 * library, so no native dependency is required. Parameters follow current OWASP guidance
 * for scrypt (N=2^17, r=8, p=1), targeting roughly 128 MiB of memory per hash.
 *
 * Opaque tokens use 32 bytes of CSPRNG entropy, base64url-encoded. Only a SHA-256 hash is
 * ever stored, so a database leak does not yield usable session or reset credentials.
 */

/**
 * Promise wrapper around Node's callback-style scrypt.
 *
 * `util.promisify` is not used here: its typings resolve to the overload without the
 * cost-parameter argument, so the N/r/p options we depend on would be silently dropped.
 */
function scryptAsync(
  plaintext: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(plaintext, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Node's default maxmem is too small for N=2^17; raise it explicitly. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const HASH_PREFIX = 'scrypt';

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Derive a credential hash with a fresh random salt. */
export async function hashPassword(plaintext: string): Promise<string> {
  assertCredentialAcceptable(plaintext);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plaintext.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  // Versioned, self-describing format so parameters can be upgraded later without
  // invalidating existing hashes.
  return [HASH_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, toBase64Url(salt), toBase64Url(derived)].join(
    '$',
  );
}

/**
 * Verify a candidate credential against a stored hash, in constant time.
 * Returns false for malformed hashes rather than throwing, so a corrupt row cannot be
 * used to distinguish accounts by error behaviour.
 */
export async function verifyPassword(candidate: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [prefix, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    if (prefix !== HASH_PREFIX) return false;

    const N = Number.parseInt(nRaw ?? '', 10);
    const r = Number.parseInt(rRaw ?? '', 10);
    const p = Number.parseInt(pRaw ?? '', 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const salt = fromBase64Url(saltRaw ?? '');
    const expected = fromBase64Url(hashRaw ?? '');
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = await scryptAsync(candidate.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      // Headroom for hashes written with higher parameters than the current default.
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 2),
    });

    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'needs_variety';

export interface PasswordCheck {
  readonly ok: boolean;
  readonly problems: readonly PasswordProblem[];
  readonly message: string | null;
}

/** A small deny-list. A real deployment should load a full breached-credential list. */
const COMMON_SECRETS = new Set([
  'password',
  'password1',
  'password123',
  '123456',
  '12345678',
  '123456789',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'abc123',
  'passw0rd',
  'p@ssw0rd',
  'fittrack',
  'fittrackai',
  'indian123',
  'changeme',
  'secret',
  'test1234',
]);

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * Enforce a minimum credential standard so an attacker cannot cheaply guess it.
 * `context` carries the user's own email/name so a credential containing them is rejected.
 */
export function checkPasswordStrength(
  candidate: string,
  context: readonly string[] = [],
): PasswordCheck {
  const problems: PasswordProblem[] = [];
  const normalized = candidate.normalize('NFKC');

  if (normalized.length < PASSWORD_MIN_LENGTH) problems.push('too_short');
  if (normalized.length > PASSWORD_MAX_LENGTH) problems.push('too_long');
  if (COMMON_SECRETS.has(normalized.toLowerCase())) problems.push('too_common');

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(normalized),
  ).length;
  if (classes < 3 && normalized.length < 16) problems.push('needs_variety');

  const lower = normalized.toLowerCase();
  for (const contextToken of context) {
    const t = contextToken.trim().toLowerCase();
    if (t.length >= 4 && lower.includes(t)) {
      problems.push('too_common');
      break;
    }
  }

  if (problems.length === 0) return { ok: true, problems: [], message: null };

  const messages: Record<PasswordProblem, string> = {
    too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    too_common: 'This is too easy to guess. Choose something unique to you.',
    needs_variety: 'Mix upper case, lower case, numbers or symbols.',
  };
  return {
    ok: false,
    problems,
    message: problems.map((p) => messages[p]).join(' '),
  };
}

function assertCredentialAcceptable(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Credential must be a non-empty string.');
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Credential must not exceed ${PASSWORD_MAX_LENGTH} characters.`);
  }
}

// =====================================================================================
// Opaque tokens
// =====================================================================================

/** A high-entropy opaque credential. The plaintext is returned once and never stored. */
export interface GeneratedToken {
  /** The plaintext value, handed to the client exactly once. */
  readonly plaintextValue: string;
  /** The SHA-256 hash that is persisted. */
  readonly storedDigest: string;
}

export function generateToken(bytes = 32): GeneratedToken {
  const plaintextValue = toBase64Url(randomBytes(bytes));
  return { plaintextValue, storedDigest: digestToken(plaintextValue) };
}

/**
 * Digest a token for storage. Tokens already carry 256 bits of entropy, so a fast hash is
 * correct here — a slow KDF would add latency without adding security.
 */
export function digestToken(plaintextValue: string): string {
  return createHash('sha256').update(plaintextValue, 'utf8').digest('hex');
}

/** Constant-time comparison of a candidate token against a stored digest. */
export function tokenMatches(candidate: string, storedDigest: string): boolean {
  const candidateBuf = Buffer.from(digestToken(candidate), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(storedDigest, 'hex');
  } catch {
    return false;
  }
  if (candidateBuf.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(candidateBuf, expected);
}

/**
 * Hash an IP address before storing it (spec §77, §79).
 *
 * Audit and session rows record who acted, which is genuinely useful for security
 * response — but retaining raw addresses is more personal data than the job needs. A
 * keyed hash keeps the ability to correlate abuse without storing the address itself.
 */
export function hashIp(ip: string | null | undefined, hashKey: string | null): string | null {
  if (!ip) return null;
  const key = hashKey ?? 'fittrack-unkeyed-dev-only';
  return createHash('sha256').update(`${key}:${ip}`).digest('hex').slice(0, 32);
}
