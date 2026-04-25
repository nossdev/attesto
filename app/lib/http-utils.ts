/**
 * Shared HTTP client helpers used by upstream-API adapters (Apple, Google).
 */

/** `typeof fetch` alias — a lot of sites want a narrowed injectable fetch. */
export type FetchLike = typeof fetch;

/** Parse response body as JSON, returning null on any failure (empty body, HTML, etc.). */
export async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
