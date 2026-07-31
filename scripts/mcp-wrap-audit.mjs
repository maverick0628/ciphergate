#!/usr/bin/env node
//
// mcp-wrap-audit — scan a Claude Code config and produce a fleet-migration plan
// for centralizing MCP-server credentials on ciphergate via `mcp-wrap`.
//
// Usage:
//   node scripts/mcp-wrap-audit.mjs [path-to-config] [--consumer=mcp-clients]
//
// Defaults to ~/.claude.json. Reads every `mcpServers` map it finds (root +
// per-project) and classifies each server:
//   - ALREADY  : already launched via mcp-wrap
//   - MIGRATE  : has an inline secret in its env → emit the set + rewrite steps
//   - SKIP     : remote/OAuth server (url/http/sse) — no static key to centralize
//   - NO SECRET: stdio server with nothing secret-looking in env
//
// Heuristics are conservative but not perfect — review the MIGRATE list before
// running anything. Nothing is changed; this only prints a plan.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith('-')) ?? `${homedir()}/.claude.json`;
const consumer = argv.find((a) => a.startsWith('--consumer='))?.split('=')[1] ?? 'mcp-clients';

let cfg;
try {
  cfg = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`mcp-wrap-audit: cannot read/parse ${path}: ${e.message}`);
  process.exit(1);
}

// Collect every mcpServers map: root (user scope) + each project.
const sources = [];
if (cfg.mcpServers && typeof cfg.mcpServers === 'object') sources.push(['user', cfg.mcpServers]);
if (cfg.projects && typeof cfg.projects === 'object') {
  for (const [proj, pcfg] of Object.entries(cfg.projects)) {
    if (pcfg && typeof pcfg === 'object' && pcfg.mcpServers) sources.push([proj, pcfg.mcpServers]);
  }
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API|CREDENTIAL|AUTH|DSN)/i;
const URLISH = /^(https?:\/\/|[\w.-]+:\d{2,5}(\/|$)|\/)/i;

/** Does this env entry look like a credential (vs a URL, host, flag, etc.)? */
function looksSecret(name, value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (URLISH.test(value)) return false; // URLs/paths/hosts are config, not the secret
  if (/^(true|false|\d+)$/i.test(value)) return false;
  return SECRET_NAME.test(name) || value.length >= 20; // name hint, or long opaque value
}

const buckets = { wrapped: [], migrate: [], remote: [], nosecret: [] };
let total = 0;

for (const [src, servers] of sources) {
  for (const [name, def] of Object.entries(servers)) {
    total++;
    const label = src === 'user' ? name : `${name} [${src}]`;
    const d = def ?? {};

    // Remote / OAuth server — no static key to broker.
    if (d.url || ['http', 'sse', 'ws', 'streamable-http'].includes(String(d.type ?? '').toLowerCase())) {
      buckets.remote.push({ label });
      continue;
    }

    const cmd = String(d.command ?? '');
    const args = Array.isArray(d.args) ? d.args : [];

    // Already wrapped?
    if (cmd.split('/').pop() === 'mcp-wrap' || args[0] === 'mcp-wrap') {
      buckets.wrapped.push({ label });
      continue;
    }

    // Inline secrets in env?
    const env = d.env && typeof d.env === 'object' ? d.env : {};
    const secrets = Object.entries(env).filter(([k, v]) => looksSecret(k, v)).map(([k]) => k);
    if (secrets.length > 0) {
      buckets.migrate.push({ label, name, cmd, args, secrets });
    } else {
      buckets.nosecret.push({ label });
    }
  }
}

const names = (arr) => (arr.length ? arr.map((e) => e.label).join(', ') : '(none)');

console.log(`Scanned ${total} MCP server(s) across ${sources.length} scope(s) in ${path}\n`);

console.log(`✅ ALREADY via mcp-wrap (${buckets.wrapped.length}): ${names(buckets.wrapped)}\n`);

console.log(`🔧 MIGRATE — inline secret(s) detected (${buckets.migrate.length}):`);
if (buckets.migrate.length === 0) console.log('  (none)');
for (const e of buckets.migrate) {
  console.log(`\n  • ${e.label} — secrets: ${e.secrets.join(', ')}`);
  console.log('    1) store in the gateway (run on the gateway host; paste the value at each prompt):');
  for (const s of e.secrets) {
    console.log(`         sudo docker exec -it ciphergate gateway secret set ${s} --consumers ${consumer}`);
  }
  const wrapped = [e.secrets.join(','), e.cmd, ...e.args].filter((x) => x !== '');
  console.log('    2) rewrite the server entry in your Claude config:');
  console.log('         "command": "mcp-wrap",');
  console.log(`         "args": ${JSON.stringify(wrapped)}`);
  console.log('         (and delete those keys from this server\'s "env" block)');
}
console.log('');

console.log(`⏭️  SKIP — remote/OAuth, no static key (${buckets.remote.length}): ${names(buckets.remote)}\n`);

console.log(`➖ NO SECRET — stdio, nothing to centralize (${buckets.nosecret.length}): ${names(buckets.nosecret)}`);

if (buckets.migrate.length > 0) {
  console.log(`\nNext: do the high-blast-radius ones first, smoke-test each with`);
  console.log(`  mcp-wrap <NAME> printenv <NAME>`);
  console.log(`then reload Claude. Review this list — the secret heuristic can have false positives.`);
}
