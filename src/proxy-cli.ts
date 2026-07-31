#!/usr/bin/env node
import { Command } from 'commander';
import { loadManifest } from './proxy/manifest.js';
import { fetchInjectedEnv, resolveConsumerKey, maskValue } from './proxy/injector.js';
import { runServer } from './proxy/runner.js';
import { startGuard } from './proxy/guard.js';

const DEFAULT_MANIFEST = process.env.GATEWAY_PROXY_MANIFEST ?? './proxy-manifest.json';

const program = new Command();
program
  .name('gateway-proxy')
  .description('Scoped-injector proxy: launch downstream MCP servers with credentials injected from ciphergate')
  .option('-m, --manifest <path>', 'path to the proxy manifest JSON', DEFAULT_MANIFEST);

program
  .command('list')
  .description('List the servers defined in the manifest')
  .action(() => {
    const manifest = loadManifest(program.opts().manifest);
    for (const [name, s] of Object.entries(manifest.servers)) {
      const secretNames = Object.keys(s.secrets);
      const target = s.transport === 'http' ? `http ${s.url}` : `${s.command} ${s.args.join(' ')}`;
      console.log(`${name}\t${target}\tsecrets: ${secretNames.join(', ') || '(none)'}`);
    }
  });

program
  .command('resolve <server>')
  .description('Dry-run: fetch the server\'s secrets and print which env vars would be injected (values masked)')
  .action(async (serverName: string) => {
    const manifest = loadManifest(program.opts().manifest);
    const server = manifest.servers[serverName];
    if (!server) {
      console.error(`No server "${serverName}". Available: ${Object.keys(manifest.servers).join(', ')}`);
      process.exit(1);
    }
    const gatewayUrl = process.env.GATEWAY_URL ?? manifest.gatewayUrl;
    const consumerKey = resolveConsumerKey(manifest, server, process.env);
    try {
      const result = await fetchInjectedEnv(server, { gatewayUrl, consumerKey });
      console.log(`Resolved ${result.fetched.length} secret(s) for "${serverName}":`);
      for (const [envName, value] of Object.entries(result.env)) {
        console.log(`  ${envName}=${maskValue(value)}`);
      }
    } catch (err) {
      console.error(`Resolve failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('run <server>')
  .description('Fetch the server\'s secrets and exec it as a stdio MCP server with credentials injected')
  .action(async (serverName: string) => {
    const manifest = loadManifest(program.opts().manifest);
    try {
      const child = await runServer(manifest, serverName);
      child.on('exit', (code) => process.exit(code ?? 0));
    } catch (err) {
      process.stderr.write(`[gateway-proxy] ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command('guard <server>')
  .description('Run the server behind the policy guard: inject creds, then filter tools / arg-check / redact over stdio')
  .action(async (serverName: string) => {
    const manifest = loadManifest(program.opts().manifest);
    try {
      await startGuard(manifest, serverName);
    } catch (err) {
      process.stderr.write(`[gateway-proxy] ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`[gateway-proxy] ${(err as Error).message}\n`);
  process.exit(1);
});
