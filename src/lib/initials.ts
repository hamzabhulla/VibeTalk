/**
 * The ONE avatar-initials implementation (Audit-7 D2). Three copies
 * used to exist and two of them were wrong: profile-dialog and
 * call-overlay carried naive versions, so "HAMZA (Admin)" rendered
 * as "H(" there while SmartAvatar rendered "HA" — a parenthesis is
 * not an initial.
 *
 * Letters only: strip leading non-letters from each word, drop
 * words with no letter, then first letter of the first word +
 * first letter of the last word ("HAMZA (Admin)" -> "HA",
 * "Azaan Manj" -> "AM"). A single word gives one letter ("Test" ->
 * "T"); a name with no letters at all gives "?".
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+/u, ""))
    .filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
