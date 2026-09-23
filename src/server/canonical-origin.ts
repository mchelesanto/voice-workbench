/**
 * Pages must be opened on the configured origin: the API guard rejects any
 * other host, and browser storage is scoped per origin. The target comes only
 * from configuration, never from the request.
 */
export function canonicalOrigin(
  host: string | null,
  configuredOrigin: string | undefined,
): string | null {
  let expected: URL;
  try {
    expected = new URL(configuredOrigin ?? "");
  } catch {
    return null;
  }
  return host === expected.host ? null : `${expected.origin}/`;
}
