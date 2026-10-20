/**
 * M57: ONE password policy, enforced identically on every path that
 * sets a password — register, reset-password, set-password, and
 * change-password ALL go through server fns (auth.functions.ts /
 * account-security.ts) that call passwordPolicyError BEFORE any
 * GoTrue call. Audit-4 M1: the old client-only checks let a
 * console/curl GoTrue call bypass min-8, the blocklist, and the
 * 72-byte cap. Honest residual (same as Audit-4 C1): a stolen
 * session can still call GoTrue's updateUser directly — GoTrue's
 * API is public and no app code can disable that. What server-side
 * enforcement closes is the APP's own flows.
 * Previously join rejected >72 chars while
 * register/reset allowed them, so a 100-char password could be
 * created but then rejected by the join validator (and GoTrue's own
 * bcrypt handling of long passwords is truncation, not rejection —
 * so register and login could silently disagree).
 *
 * Max 72 = bcrypt's input cap in BYTES (GoTrue hashes with bcrypt,
 * which truncates past 72 bytes). Min 8 = the existing floor in
 * characters, counted in CODE POINTS (Audit-4 L5): `password.length`
 * counts UTF-16 units, so 4 emoji (8 units, 4 code points) used to
 * pass "min 8". `[...password].length` counts each surrogate-pair
 * character once. (ZWJ sequences count as multiple code points —
 * accepted: code points are the well-defined unit here.)
 * (password.length), so 72×"é" (144 bytes) passed the client but
 * bcrypt silently kept only the first 36 é — two passwords differing
 * after byte 72 collided. The max is now measured in bytes.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

// Audit-3 A2-N9: defence-in-depth blocklist of the most common /
// most-breached passwords. Exact match only (case-insensitive) —
// "password123!" still passes (it is not exactly "password123").
// The real breach check is GoTrue's "Leaked password protection"
// dashboard toggle (HaveIBeenPwned); this list only catches the
// trivially guessable ones client-side when that toggle is off or
// the request bypasses GoTrue. Keep the list short and stable.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password1234", "passw0rd",
  "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890",
  "12345678910", "1234567", "123456", "123123", "123321", "654321",
  "11111111", "00000000", "qwerty", "qwerty123", "qwertyuiop", "qwertyui",
  "abc123", "abc123456", "1q2w3e4r", "1qaz2wsx", "qazwsx", "iloveyou",
  "monkey", "dragon", "football", "letmein", "login", "admin123",
  "welcome", "welcome1", "sunshine", "master", "superman", "michael",
  "shadow", "changeme", "default", "aaaaaaaa", "trustno1", "hello123",
  "freedom", "whatever", "secret", "starwars", "princess", "pokemon",
  "charlie", "donald", "jordan", "tiger", "jennifer", "michelle",
  "hunter", "buster", "soccer", "baseball", "killer", "george",
  "thomas", "jessica", "pepper", "mypass", "test123", "guest123",
]);

// Audit-7 A1: invisible characters are stripped by CATEGORY, not
// by the enumerated list Audit-5/6 used — an executed 15-character
// sweep (U+200E/200F, U+202A–U+202E, U+2061–U+2064, U+00AD, U+061C,
// U+034F, U+17B4) bypassed BOTH gates below: "a" + 7× U+200E
// counted as 8 characters, and 8× U+200E alone passed as a fully
// invisible password. \p{Cf} is the whole Unicode format category
// (every zero-width / bidi-control / joiner char, U+00AD included).
// The three extra chars are category-Mn combining marks that are
// non-printing by design (U+034F grapheme joiner, U+17B4, U+180E —
// the last was Cf until Unicode 7 reclassified it). Real combining
// marks (e.g. Devanagari vowel signs) are visible password
// characters and are deliberately NOT stripped.
const INVISIBLE_FOR_LENGTH = /[\p{Cf}\u034F\u17B4\u180E]/gu;
const INVISIBLE_OR_SPACE = /[\s\p{Cf}\u034F\u17B4\u180E]/gu;

/** Returns an error message when the password violates the policy, else null. */
export function passwordPolicyError(password: string): string | null {
  // Audit-2 L23: 8 spaces passed (length 8, bytes 8). A password of
  // nothing but whitespace is not a password. Checked FIRST so a
  // short all-whitespace input gets this specific message, not the
  // min-length one. Padded-but-real passwords ("  secret  ") are NOT
  // rejected — trimming would corrupt intentional spaces.
  // Audit-5 B3-LOW: String.trim() leaves zero-width/format
  // characters (U+200B/U+200C/U+200D/U+2060) — an "invisible"
  // password of 8× U+200B passed this guard and the min-length
  // check. A password with nothing but whitespace/format
  // characters is not a password. (Padding around a REAL
  // password stays allowed — only all-blank inputs reject.)
  // (Audit-7 A1: the strip set is now INVISIBLE_OR_SPACE — see the
  // note above the function.)
  if (!password.replace(INVISIBLE_OR_SPACE, "")) {
    return "Password cannot be all whitespace.";
  }
  // Audit-6 A6-INFO-2: zero-width/format characters must not count
  // toward the minimum — "a" + 7x U+200B reached 8 code points
  // while being a 1-character password in every way that matters.
  // (Real spaces still count: they are intentional characters in a
  // padded password, per L23 above.)
  if ([...password.replace(INVISIBLE_FOR_LENGTH, "")].length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  // Audit-2 M12: measure BYTES, not UTF-16 units (see header).
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    return `Password must fit in ${PASSWORD_MAX_LENGTH} bytes — multi-byte characters count more than one.`;
  }
  // Audit-3 A2-N9: block the most common passwords (exact match).
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "This password is too common — choose a less guessable one.";
  }
  return null;
}
