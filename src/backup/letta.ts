/**
 * Letta agent backup — list the agents and export each one's serialized state.
 *
 * Letta (0.16.x) exposes `GET /v1/agents/` (list) and `GET /v1/agents/{id}/export`
 * (a JSON agent file that `POST /v1/agents/import` can reload). Auth is a bearer
 * token. Exports are returned as raw bytes so the runner can encrypt + upload
 * them like any other artifact.
 */

export interface LettaConfig {
  /** Letta base, e.g. http://localhost:8283 */
  lettaUrl: string;
  /** Bearer token (LETTA_API_KEY). */
  lettaKey: string;
}

export interface LettaAgent {
  id: string;
  name: string;
}

type FetchFn = typeof fetch;

const base = (cfg: LettaConfig): string => cfg.lettaUrl.replace(/\/$/, '');
const authHeaders = (cfg: LettaConfig): Record<string, string> => ({ Authorization: `Bearer ${cfg.lettaKey}` });

/** List all agents (id + name). */
export async function listAgents(cfg: LettaConfig, fetchFn: FetchFn = fetch): Promise<LettaAgent[]> {
  const res = await fetchFn(`${base(cfg)}/v1/agents/`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
  const json = (await res.json()) as Array<{ id: string; name?: string }>;
  return json.map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

/** Export one agent's serialized state as bytes. */
export async function exportAgent(cfg: LettaConfig, id: string, fetchFn: FetchFn = fetch): Promise<Buffer> {
  const res = await fetchFn(`${base(cfg)}/v1/agents/${encodeURIComponent(id)}/export`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`export agent ${id} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** List then export every agent. Returns one entry per agent with its export bytes. */
export async function exportAllAgents(
  cfg: LettaConfig,
  fetchFn: FetchFn = fetch,
): Promise<Array<{ id: string; name: string; data: Buffer }>> {
  const agents = await listAgents(cfg, fetchFn);
  const out: Array<{ id: string; name: string; data: Buffer }> = [];
  for (const agent of agents) {
    out.push({ id: agent.id, name: agent.name, data: await exportAgent(cfg, agent.id, fetchFn) });
  }
  return out;
}
