/**
 * Embed a string via any OpenAI-compatible `/embeddings` endpoint.
 *
 * The watchdog records incidents and recoveries as vectors so past events stay
 * semantically searchable. That needs exactly one primitive, and this is it —
 * about twenty lines against a documented wire format, with no dependency on
 * whatever produced the collection being written to.
 */

export interface EmbedConfig {
  /** Base URL of the embeddings API, without the trailing `/embeddings`. */
  embedUrl: string;
  embedModel: string;
  embedApiKey?: string;
  /** Prepended to the text before embedding. Some models expect a task prefix. */
  queryPrefix?: string;
}

export async function embedQuery(
  query: string,
  cfg: EmbedConfig,
  fetchFn: typeof fetch = fetch,
): Promise<number[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.embedApiKey) headers.Authorization = `Bearer ${cfg.embedApiKey}`;

  const res = await fetchFn(`${cfg.embedUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.embedModel, input: `${cfg.queryPrefix ?? ''}${query}` }),
  });

  if (!res.ok) {
    throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embeddings response had no vector');
  }
  return vector;
}
