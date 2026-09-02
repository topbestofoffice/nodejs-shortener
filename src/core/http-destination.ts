export const maximumHttpDestinationLength = 4_096;

/**
 * Normalize a newly submitted HTTP(S) destination without rewriting its URL
 * spelling. Spaces surrounding a PHP-compatible form value are removed, but
 * control characters anywhere in the submitted value are rejected.
 */
export function normalizeHttpDestination(raw: string): string | null {
  if (containsAsciiControlCharacter(raw)) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > maximumHttpDestinationLength) return null;
  return hasSafeHttpUrlShape(value) ? value : null;
}

function hasSafeHttpUrlShape(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1F || codePoint === 0x7F;
  });
}
