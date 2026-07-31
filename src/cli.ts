#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { SqliteStorage } from './storage/sqlite.js';
import { deriveKey } from './storage/crypto.js';
import { SecretCache } from './core/cache.js';
import { AuthManager } from './core/auth.js';
import { AuditLogger } from './core/audit.js';
import { SecretsService } from './core/secrets-service.js';
import { getRemoteConfigFromEnv, RemoteClient } from './cli-remote.js';
import { setUiPassword } from './ui/credentials.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Throws if remote mode is active. Use in commands that only make sense against
 * a local SQLite gateway (init, backup/restore, consumer management).
 */
function rejectInRemoteMode(commandName: string): void {
  if (process.env.GATEWAY_URL) {
    throw new Error(
      `'${commandName}' operates on a local gateway instance and is not available in remote mode (GATEWAY_URL is set).`,
    );
  }
}

function parseDuration(input: string): string {
  const now = new Date();
  const match = input.match(/^(\d+)(d|m|y)$/);
  if (match) {
    const [, num, unit] = match;
    const n = parseInt(num, 10);
    if (unit === 'd') now.setDate(now.getDate() + n);
    else if (unit === 'm') now.setMonth(now.getMonth() + n);
    else if (unit === 'y') now.setFullYear(now.getFullYear() + n);
    return now.toISOString();
  }
  // Try ISO date
  const d = new Date(input);
  if (!isNaN(d.getTime())) return d.toISOString();
  throw new Error(`Invalid duration: ${input}`);
}

/**
 * Make a readline interface redraw `label` instead of whatever is typed.
 *
 * In terminal mode readline repaints the whole line on every keystroke, and the
 * repaint starts by clearing to end of screen. A prompt written with
 * `process.stdout.write` *before* `question()` is therefore erased by the first
 * repaint: the prompt flashes and vanishes, and the command looks hung while it
 * sits there silently reading input. Muting `_writeToOutput` stops the echo of
 * typed characters but not that clear — the clear is issued directly against
 * the output stream.
 *
 * So let readline own the prompt and make its renderer repaint the prompt
 * rather than the buffer. The prompt stays on screen, the value never reaches
 * it.
 */
function maskPromptOutput(rl: ReturnType<typeof createInterface>, label: string): void {
  (rl as unknown as { _writeToOutput?: (str: string) => void })._writeToOutput = () => {
    // Clear the line, return to column 1, repaint the prompt alone.
    process.stdout.write(`\x1b[2K\x1b[1G${label}`);
  };
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const isTTY = Boolean(process.stdin.isTTY);
    // `terminal` must be true for the input to be masked: only then does
    // readline put the TTY into raw mode (disabling the terminal's own echo)
    // and do its own echoing — which we then suppress. With only `input` set,
    // raw mode is never enabled and the terminal echoes the typed value.
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });

    // On EOF with no line at all (`printf '' | gateway secret set X`), question's
    // callback never fires: the promise never settles and the process exits 0
    // having done nothing, reporting success for a no-op. Resolve '' instead and
    // let the caller reject it.
    let answered = false;
    rl.on('close', () => {
      if (!answered) {
        answered = true;
        resolve('');
      }
    });

    if (isTTY) {
      // Keystrokes must never echo, but the prompt must stay visible — see
      // maskPromptOutput. (Non-TTY input — pipes, tests — has nothing to mask.)
      maskPromptOutput(rl, prompt);
      rl.question(prompt, (answer) => {
        answered = true;
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
      return;
    }

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read two hidden lines from a *single* readline interface.
 *
 * Two sequential promptHidden() calls cannot share a piped stdin: the first
 * interface consumes the stream, and closing it leaves the second at EOF, so
 * the confirmation always reads back empty and every scripted invocation looks
 * like a mismatch. One interface, two questions.
 *
 * A short read (one line piped, or none) yields '' for the missing answers,
 * which the caller rejects.
 */
function promptHiddenPair(firstPrompt: string, secondPrompt: string): Promise<[string, string]> {
  return new Promise((resolve) => {
    const isTTY = Boolean(process.stdin.isTTY);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });

    const answers: string[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve([answers[0] ?? '', answers[1] ?? '']);
    };

    rl.on('close', finish);

    const ask = (label: string, next: () => void) => {
      if (isTTY) {
        // Keystrokes must never appear, but the prompt has to survive
        // readline's repaint — see maskPromptOutput. Piped input needs neither.
        maskPromptOutput(rl, label);
        rl.question(label, (answer) => {
          answers.push(answer);
          process.stdout.write('\n');
          next();
        });
        return;
      }
      rl.question(label, (answer) => {
        answers.push(answer);
        next();
      });
    };

    ask(firstPrompt, () => ask(secondPrompt, finish));
  });
}

async function readSecretValue(providedValue?: string): Promise<string> {
  if (providedValue !== undefined) return providedValue;

  // `secret set` is a destructive upsert, and the two ways a prompt can come
  // back empty both used to silently overwrite the stored value with '':
  // readline resolves '' on a bare Enter, and on EOF when stdin is not a TTY
  // (a pasted one-liner, a script, CI). HOME_ASSISTANT_TOKEN was destroyed this
  // way on 2026-07-27 by a command whose only intent was to widen the consumer
  // list. There is no rollback — `secret history` records that a change
  // happened, not the value it replaced.
  //
  // To change consumers or tags without touching the value, use `secret grant`.
  //
  // Piping a real value in with no --value stays supported — that is a genuine
  // scripting path. Only the empty result is refused.
  const value = await promptHidden('Secret value: ');
  if (value === '') {
    throw new Error(
      'refusing to store an empty value (bare Enter, or EOF on a non-TTY stdin). ' +
        'Use `secret grant` to change consumers or tags without touching the value, ' +
        "or pass --value '' explicitly if you really mean to blank it.",
    );
  }
  return value;
}

// ── Stack initializer ─────────────────────────────────────────────────────────

async function createStack(config = loadConfig()) {
  const keyfileContent = readFileSync(config.keyfilePath);
  const storage = new SqliteStorage(config.dbPath, config.maxHistory);
  let salt: Buffer;
  try {
    salt = storage.getSalt();
  } catch {
    storage.close();
    throw new Error('Database not initialized. Run: gateway init');
  }
  const encryptionKey = await deriveKey(keyfileContent, salt);
  const cache = new SecretCache(config.cacheTtl);
  const auth = new AuthManager(storage);
  const audit = new AuditLogger(storage, {
    enabled: config.pushoverEnabled,
    appToken: config.pushoverAppToken ?? '',
    userKey: config.pushoverUserKey ?? '',
    alertAuthFailure: config.alertAuthFailure,
    alertDelete: config.alertDelete,
    alertUpdate: config.alertUpdate,
    alertCreate: config.alertCreate,
    alertRead: config.alertRead,
    alertList: config.alertList,
    alertRotationWarning: config.alertRotationWarning,
    minSeverity: config.alertMinSeverity,
    rateLimitMax: config.alertRateLimitMax,
    rateLimitWindowSec: config.alertRateLimitWindowSec,
  });
  const service = new SecretsService(storage, encryptionKey, cache, audit);
  return { storage, auth, service, encryptionKey };
}

/**
 * Wraps an async Commander action to catch errors and exit with code 1.
 * This handles both errors thrown from createStack and any other runtime errors.
 */
function cliAction<T extends unknown[]>(fn: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (e: unknown) {
      const err = e as Error;
      console.error(err.message ?? String(e));
      process.exit(1);
    }
  };
}

/**
 * List all secrets directly from the DB, bypassing the consumer filter.
 * Used for admin-level CLI operations where we need to see all secrets.
 */
function listAllSecrets(dbPath: string, tag?: string): Array<{ name: string; version: number; updated_at: string; tags: string[]; consumers: string[]; rotation_days: number | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    type RawRow = { name: string; version: number; updated_at: string; tags: string; consumers: string; rotation_days: number | null };
    const rows = db.prepare<[], RawRow>('SELECT name, version, updated_at, tags, consumers, rotation_days FROM secrets').all();
    return rows
      .map(r => ({ ...r, tags: JSON.parse(r.tags) as string[], consumers: JSON.parse(r.consumers) as string[] }))
      .filter(r => tag === undefined || r.tags.includes(tag));
  } finally {
    db.close();
  }
}

// ── Program ───────────────────────────────────────────────────────────────────

export const program = new Command();
program.name('gateway').version('1.1.0').exitOverride();

// ── gateway init ──────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize the gateway database and create first admin consumer')
  .action(cliAction(async () => {
    rejectInRemoteMode('init');
    const config = loadConfig();

    if (!existsSync(config.keyfilePath)) {
      console.error(`Keyfile not found: ${config.keyfilePath}`);
      process.exit(1);
    }

    const storage = new SqliteStorage(config.dbPath, config.maxHistory);

    let alreadyInit = false;
    try {
      storage.getSalt();
      alreadyInit = true;
    } catch {
      // Not yet initialized — expected
    }

    if (alreadyInit) {
      console.error('Database already initialized.');
      storage.close();
      process.exit(1);
    }

    const salt = randomBytes(32);
    storage.setSalt(salt);

    const auth = new AuthManager(storage);
    const { apiKey } = auth.createConsumer('admin', 'admin', 'Initial admin consumer');

    console.log('Gateway initialized.');
    console.log(`Admin API key (save this — it will not be shown again):\n${apiKey}`);

    storage.close();
  }));

// ── gateway consumer ──────────────────────────────────────────────────────────

const consumer = program.command('consumer').description('Manage API consumers');

consumer
  .command('add <name>')
  .description('Create a new consumer and print its API key')
  .option('--admin', 'Grant admin role')
  .option('--expires <duration>', 'Expiry duration (e.g. 90d, 6m, 1y) or ISO 8601 date')
  .action(cliAction(async (name: string, opts: { admin?: boolean; expires?: string }) => {
    rejectInRemoteMode('consumer add');
    const { storage, auth } = await createStack();
    try {
      const role = opts.admin ? 'admin' : 'reader';
      const expiresAt = opts.expires ? parseDuration(opts.expires) : undefined;
      const { apiKey } = auth.createConsumer(name, role, undefined, expiresAt);
      console.log(`Consumer '${name}' created (role: ${role}).`);
      console.log(`API key (save this — it will not be shown again):\n${apiKey}`);
    } finally {
      storage.close();
    }
  }));

consumer
  .command('list')
  .description('List all consumers')
  .action(cliAction(async () => {
    rejectInRemoteMode('consumer list');
    const { storage } = await createStack();
    try {
      const consumers = storage.listConsumers();
      if (consumers.length === 0) {
        console.log('No consumers found.');
        return;
      }
      for (const c of consumers) {
        const status = !c.is_active
          ? 'revoked'
          : c.expires_at && new Date(c.expires_at) < new Date()
            ? 'expired'
            : 'active';
        const expiry = c.expires_at ? `  expires=${c.expires_at}` : '';
        console.log(`${c.name}  role=${c.role}  status=${status}${expiry}`);
      }
    } finally {
      storage.close();
    }
  }));

consumer
  .command('revoke <name>')
  .description("Revoke a consumer's access")
  .action(cliAction(async (name: string) => {
    rejectInRemoteMode('consumer revoke');
    const { storage } = await createStack();
    try {
      storage.revokeConsumer(name);
      console.log(`Consumer '${name}' revoked.`);
    } finally {
      storage.close();
    }
  }));

consumer
  .command('rotate-key <name>')
  .description("Rotate a consumer's API key")
  .option('--expires <duration>', 'New expiry duration (e.g. 90d, 6m, 1y) or ISO 8601 date')
  .action(cliAction(async (name: string, opts: { expires?: string }) => {
    rejectInRemoteMode('consumer rotate-key');
    const { storage, auth } = await createStack();
    try {
      const expiresAt = opts.expires ? parseDuration(opts.expires) : undefined;
      const { apiKey } = auth.rotateKey(name, expiresAt);
      console.log(`Key rotated for consumer '${name}'.`);
      console.log(`New API key (save this — it will not be shown again):\n${apiKey}`);
    } finally {
      storage.close();
    }
  }));

// ── gateway secret ────────────────────────────────────────────────────────────

const secret = program.command('secret').description('Manage secrets');

secret
  .command('grant <name>')
  .description('Change consumers or tags WITHOUT touching the stored value')
  .option('--consumers <list>', 'Comma-separated consumer names (replaces the existing list)')
  .option('--tags <list>', 'Comma-separated tags (replaces the existing list)')
  .action(cliAction(async (name: string, opts: { consumers?: string; tags?: string }) => {
    // The storage layer has always supported this — `updateSecret` only
    // re-encrypts when `value !== undefined` — but no CLI path reached it, so
    // every grant went through the destructive upsert in `secret set`.
    //
    // Both lists REPLACE rather than append, matching `secret set`. Read the
    // current sets first (`secret list`) and pass everything that should keep
    // access; anything omitted is dropped.
    const consumers = opts.consumers !== undefined ? opts.consumers.split(',').map(s => s.trim()) : undefined;
    const tags = opts.tags !== undefined ? opts.tags.split(',').map(s => s.trim()) : undefined;
    if (consumers === undefined && tags === undefined) {
      throw new Error('nothing to change: pass --consumers and/or --tags');
    }

    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      if (!(await client.secretExists(name))) {
        throw new Error(`Secret '${name}' does not exist. Use \`secret set\` to create it.`);
      }
      await client.updateSecret(name, { consumers, tags });
      console.log(`Secret '${name}' updated (value untouched).`);
      return;
    }

    const { storage, service } = await createStack();
    try {
      if (!storage.getSecret(name)) {
        throw new Error(`Secret '${name}' does not exist. Use \`secret set\` to create it.`);
      }
      service.updateSecret(name, { consumers, tags }, 'cli', 'local');
      console.log(`Secret '${name}' updated (value untouched).`);
    } finally {
      storage.close();
    }
  }));

secret
  .command('set <name>')
  .description('Create or update a secret (upsert) — OVERWRITES the value')
  .option('--value <val>', 'Secret value. Omitting it prompts (TTY only); an empty answer is refused, not stored')
  .option('--consumers <list>', 'Comma-separated consumer names')
  .option('--tags <list>', 'Comma-separated tags')
  .option('--rotation-days <n>', 'Rotation policy in days')
  .action(cliAction(async (name: string, opts: { value?: string; consumers?: string; tags?: string; rotationDays?: string }) => {
    const remote = getRemoteConfigFromEnv();
    const value = await readSecretValue(opts.value);
    const consumers = opts.consumers !== undefined ? opts.consumers.split(',').map(s => s.trim()) : undefined;
    const tags = opts.tags !== undefined ? opts.tags.split(',').map(s => s.trim()) : undefined;
    const rotationDays = opts.rotationDays ? parseInt(opts.rotationDays, 10) : undefined;

    if (remote) {
      const client = new RemoteClient(remote);
      const exists = await client.secretExists(name);
      if (exists) {
        await client.updateSecret(name, { value, consumers, tags, rotation_days: rotationDays });
        console.log(`Secret '${name}' updated.`);
      } else {
        await client.createSecret({ name, value, consumers: consumers ?? [], tags: tags ?? [], rotation_days: rotationDays });
        console.log(`Secret '${name}' created.`);
      }
      return;
    }

    const { storage, service } = await createStack();
    try {
      const existing = storage.getSecret(name);
      if (existing) {
        service.updateSecret(name, { value, consumers, tags, rotation_days: rotationDays }, 'cli', 'local');
        console.log(`Secret '${name}' updated.`);
      } else {
        service.createSecret({ name, value, consumers: consumers ?? [], tags: tags ?? [], rotation_days: rotationDays }, 'cli', 'local');
        console.log(`Secret '${name}' created.`);
      }
    } finally {
      storage.close();
    }
  }));

secret
  .command('get <name>')
  .description('Print decrypted secret value to stdout')
  .action(cliAction(async (name: string) => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      const result = await client.getSecret(name);
      console.log(result.value);
      return;
    }

    const { storage, service } = await createStack();
    try {
      const result = service.getSecret(name, 'cli', 'admin', 'local');
      if ('error' in result) {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
      console.log(result.value);
    } finally {
      storage.close();
    }
  }));

secret
  .command('list')
  .description('List secrets')
  .option('--tag <tag>', 'Filter by tag')
  .option('--consumer <name>', 'Filter by consumer access')
  .action(cliAction(async (opts: { tag?: string; consumer?: string }) => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      const { secrets } = await client.listSecrets(opts.tag);
      // The server has no consumer-scoped list endpoint, so apply the filter here.
      const filtered = opts.consumer
        ? secrets.filter(s => (s.consumers ?? []).includes(opts.consumer!))
        : secrets;
      if (filtered.length === 0) {
        console.log('No secrets found.');
        return;
      }
      for (const s of filtered) {
        const tags = s.tags ?? [];
        const consumers = s.consumers ?? [];
        const tagsStr = tags.length > 0 ? `  tags=[${tags.join(',')}]` : '';
        const consumersStr = consumers.length > 0 ? `  consumers=[${consumers.join(',')}]` : '';
        console.log(`${s.name}  v${s.version}  updated=${s.updated_at}${tagsStr}${consumersStr}`);
      }
      return;
    }

    const config = loadConfig();
    // Ensure DB is initialized before proceeding
    const { storage } = await createStack(config);
    storage.close();

    let secrets: Array<{ name: string; version: number; updated_at: string; tags: string[]; consumers: string[] }>;

    if (opts.consumer) {
      // Only show secrets accessible to the named consumer
      const tmp = new SqliteStorage(config.dbPath, config.maxHistory);
      try {
        secrets = tmp.listSecrets(opts.consumer, opts.tag);
      } finally {
        tmp.close();
      }
    } else {
      // Admin list: read all secrets directly from DB, bypassing consumer filter
      secrets = listAllSecrets(config.dbPath, opts.tag);
    }

    if (secrets.length === 0) {
      console.log('No secrets found.');
      return;
    }
    for (const s of secrets) {
      const tagsStr = s.tags.length > 0 ? `  tags=[${s.tags.join(',')}]` : '';
      const consumersStr = s.consumers.length > 0 ? `  consumers=[${s.consumers.join(',')}]` : '';
      console.log(`${s.name}  v${s.version}  updated=${s.updated_at}${tagsStr}${consumersStr}`);
    }
  }));

secret
  .command('delete <name>')
  .description('Delete a secret permanently')
  .action(cliAction(async (name: string) => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      await client.deleteSecret(name);
      console.log(`Secret '${name}' deleted.`);
      return;
    }

    const { storage, service } = await createStack();
    try {
      const existing = storage.getSecret(name);
      if (!existing) {
        console.error(`Secret '${name}' not found.`);
        process.exit(1);
      }
      service.deleteSecret(name, 'cli', 'local');
      console.log(`Secret '${name}' deleted.`);
    } finally {
      storage.close();
    }
  }));

secret
  .command('history <name>')
  .description('Show version history for a secret')
  .action(cliAction(async (name: string) => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      const result = await client.getHistory(name);
      console.log(`Secret: ${result.name}  current_version=${result.current_version}`);
      if (result.history.length === 0) {
        console.log('No history entries.');
        return;
      }
      for (const h of result.history) {
        console.log(`  v${h.version}  changed_at=${h.changed_at}  changed_by=${h.changed_by}`);
      }
      return;
    }

    const { storage, service } = await createStack();
    try {
      const result = service.getHistory(name);
      console.log(`Secret: ${result.name}  current_version=${result.current_version}`);
      if (result.history.length === 0) {
        console.log('No history entries.');
        return;
      }
      for (const h of result.history) {
        console.log(`  v${h.version}  changed_at=${h.changed_at}  changed_by=${h.changed_by}`);
      }
    } finally {
      storage.close();
    }
  }));

// ── gateway env ───────────────────────────────────────────────────────────────

program
  .command('env')
  .description('Output dotenv-formatted secrets to stdout')
  .option('--tag <tag>', 'Filter by tag')
  .option('--names <list>', 'Comma-separated secret names to include')
  .option('--consumer <name>', "Scope to a specific consumer's accessible secrets")
  .action(cliAction(async (opts: { tag?: string; names?: string; consumer?: string }) => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const client = new RemoteClient(remote);
      const names = opts.names ? opts.names.split(',').map(s => s.trim()) : undefined;
      const output = await client.getEnv({ tag: opts.tag, names });
      const lines = output.split('\n').filter(l => l.length > 0);
      for (const line of lines) console.log(line);
      return;
    }

    const config = loadConfig();
    const { storage, service } = await createStack(config);
    try {
      const names = opts.names ? opts.names.split(',').map(s => s.trim()) : undefined;
      const consumerName = opts.consumer ?? 'cli';
      const consumerRole = opts.consumer ? 'reader' : 'admin';

      // For admin (no --consumer), build env from all secrets directly
      if (!opts.consumer) {
        const allSecrets = listAllSecrets(config.dbPath, opts.tag);
        const filtered = names ? allSecrets.filter(s => names.includes(s.name)) : allSecrets;
        for (const s of filtered) {
          const result = service.getSecret(s.name, 'cli', 'admin', 'local');
          if (!('error' in result)) {
            console.log(`${s.name}=${result.value}`);
          }
        }
      } else {
        const output = service.getEnv(consumerName, consumerRole, { tag: opts.tag, names });
        // Write each line via console.log (strips trailing newline from getEnv)
        const lines = output.split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          console.log(line);
        }
      }
    } finally {
      storage.close();
    }
  }));

// ── gateway rotation-report ───────────────────────────────────────────────────

interface RotationReport {
  overdue: Array<{ name: string; age_days: number; rotation_days: number }>;
  due: Array<{ name: string; age_days: number; rotation_days: number }>;
  ok: Array<{ name: string; age_days: number; rotation_days: number }>;
}

function printRotationReport(report: RotationReport): void {
  if (report.overdue.length > 0) {
    console.log('OVERDUE:');
    for (const e of report.overdue) {
      console.log(`  ${e.name}  age=${e.age_days}d  rotation_policy=${e.rotation_days}d`);
    }
  }
  if (report.due.length > 0) {
    console.log('DUE SOON:');
    for (const e of report.due) {
      console.log(`  ${e.name}  age=${e.age_days}d  rotation_policy=${e.rotation_days}d`);
    }
  }
  if (report.ok.length > 0) {
    console.log('OK:');
    for (const e of report.ok) {
      console.log(`  ${e.name}  age=${e.age_days}d  rotation_policy=${e.rotation_days}d`);
    }
  }
  if (report.overdue.length === 0 && report.due.length === 0 && report.ok.length === 0) {
    console.log('No secrets with rotation policies found.');
  }
}

program
  .command('rotation-report')
  .description('Show rotation status for all secrets')
  .action(cliAction(async () => {
    const remote = getRemoteConfigFromEnv();
    if (remote) {
      const report = await new RemoteClient(remote).rotationReport();
      printRotationReport(report);
      return;
    }
    const { storage, service } = await createStack();
    try {
      printRotationReport(service.rotationReport());
    } finally {
      storage.close();
    }
  }));

// ── gateway audit ─────────────────────────────────────────────────────────────

program
  .command('audit')
  .description('Show audit log entries')
  .option('--limit <n>', 'Maximum number of entries to show', '50')
  .option('--consumer <name>', 'Filter by consumer')
  .option('--since <date>', 'Show entries since this date (ISO 8601)')
  .action(cliAction(async (opts: { limit?: string; consumer?: string; since?: string }) => {
    const remote = getRemoteConfigFromEnv();
    const limit = opts.limit ? parseInt(opts.limit, 10) : 50;

    if (remote) {
      const client = new RemoteClient(remote);
      const { entries } = await client.getAudit({ limit, consumer: opts.consumer, since: opts.since });
      printAuditEntries(entries);
      return;
    }

    const { storage, service } = await createStack();
    try {
      const entries = service.getAuditLog({ limit, consumer: opts.consumer, since: opts.since });
      printAuditEntries(entries);
    } finally {
      storage.close();
    }
  }));

interface AuditEntryShape {
  timestamp: string;
  consumer: string;
  action: string;
  success: number | boolean;
  secret_name?: string | null;
  ip_address?: string | null;
  details?: string | null;
}

function printAuditEntries(entries: AuditEntryShape[]): void {
  if (entries.length === 0) {
    console.log('No audit entries found.');
    return;
  }
  for (const e of entries) {
    const secretPart = e.secret_name ? `  secret=${e.secret_name}` : '';
    const detailsPart = e.details ? `  details=${e.details}` : '';
    const ipPart = e.ip_address ? `  ip=${e.ip_address}` : '';
    const status = e.success ? 'ok' : 'fail';
    console.log(`${e.timestamp}  ${e.consumer}  ${e.action}  ${status}${secretPart}${ipPart}${detailsPart}`);
  }
}

// ── gateway ui ────────────────────────────────────────────────────────────────

const ui = program.command('ui').description('Manage the browser UI');

ui
  .command('set-password')
  .description('Set or rotate the browser UI password')
  .option('--user <name>', 'UI user to set the password for', 'admin')
  .action(cliAction(async (opts: { user: string }) => {
    rejectInRemoteMode('ui set-password');
    const config = loadConfig();

    // Prompted twice, never accepted as a flag. A password in argv is visible
    // to every process on the box and lands in shell history.
    const [first, second] = await promptHiddenPair('UI password: ', 'Confirm password: ');

    if (first !== second) {
      throw new Error('Passwords did not match — nothing was written.');
    }

    const storage = new SqliteStorage(config.dbPath, config.maxHistory);
    try {
      // setUiPassword enforces the length floor and throws below it.
      await setUiPassword(storage, opts.user, first);
      console.log(`UI password set for '${opts.user}'.`);
    } finally {
      storage.close();
    }
  }));

// ── gateway backup ────────────────────────────────────────────────────────────

program
  .command('backup')
  .description('Backup the SQLite database')
  .option('--output <path>', 'Destination path for the backup file')
  .action(cliAction(async (opts: { output?: string }) => {
    rejectInRemoteMode('backup');
    const config = loadConfig();
    if (!opts.output) {
      console.error('--output <path> is required');
      process.exit(1);
    }
    copyFileSync(config.dbPath, opts.output);
    console.log(`Backup written to ${opts.output}`);
  }));

// ── gateway restore ───────────────────────────────────────────────────────────

program
  .command('restore <path>')
  .description('Restore the database from a backup file')
  .action(cliAction(async (backupPath: string) => {
    rejectInRemoteMode('restore');
    const config = loadConfig();
    if (!existsSync(backupPath)) {
      console.error(`Backup file not found: ${backupPath}`);
      process.exit(1);
    }
    copyFileSync(backupPath, config.dbPath);
    console.log(`Database restored from ${backupPath}`);
  }));

// ── gateway import ───────────────────────────────────────────────────────────

program
  .command('import <path>')
  .description('Import secrets from a YAML seed file')
  .option('--dry-run', 'Show what would be imported without making changes')
  .option('--skip-empty', 'Skip entries with empty values', true)
  .action(cliAction(async (seedPath: string, opts: { dryRun?: boolean; skipEmpty?: boolean }) => {
    rejectInRemoteMode('import');
    if (!existsSync(seedPath)) {
      console.error(`Seed file not found: ${seedPath}`);
      process.exit(1);
    }

    const { service, storage } = await createStack();

    // Simple YAML parser for our seed format (no external dep needed)
    const content = readFileSync(seedPath, 'utf-8');
    const entries = parseSecretsSeedYaml(content);

    let imported = 0;
    let skipped = 0;
    let updated = 0;
    let errors = 0;

    for (const entry of entries) {
      if (opts.skipEmpty !== false && (!entry.value || entry.value === '')) {
        if (opts.dryRun) console.log(`SKIP (empty)  ${entry.name}`);
        skipped++;
        continue;
      }

      if (opts.dryRun) {
        console.log(`IMPORT  ${entry.name}  consumers=[${entry.consumers.join(',')}]  tags=[${entry.tags.join(',')}]`);
        imported++;
        continue;
      }

      try {
        // Check if secret already exists
        const existing = storage.getSecret(entry.name);
        if (existing) {
          // Update it
          service.updateSecret(entry.name, {
            value: entry.value,
            description: entry.description,
            consumers: entry.consumers,
            tags: entry.tags,
            rotation_days: entry.rotation_days,
          }, 'admin', 'cli-import');
          console.log(`UPDATED  ${entry.name} (v${existing.version} → v${existing.version + 1})`);
          updated++;
        } else {
          service.createSecret({
            name: entry.name,
            value: entry.value,
            description: entry.description,
            consumers: entry.consumers,
            tags: entry.tags,
            rotation_days: entry.rotation_days,
          }, 'admin', 'cli-import');
          console.log(`CREATED  ${entry.name}`);
          imported++;
        }
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`ERROR    ${entry.name}: ${e.message}`);
        errors++;
      }
    }

    console.log(`\nDone: ${imported} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);
    storage.close();
  }));

interface SeedEntry {
  name: string;
  value: string;
  consumers: string[];
  tags: string[];
  description?: string;
  rotation_days?: number;
}

function parseSecretsSeedYaml(content: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  let current: Partial<SeedEntry> | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('- name:')) {
      if (current?.name) entries.push(finalizeSeedEntry(current));
      current = { name: extractYamlValue(line.slice('- name:'.length)) };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('value:')) {
      current.value = extractYamlValue(line.slice('value:'.length));
    } else if (line.startsWith('consumers:')) {
      current.consumers = extractYamlArray(line.slice('consumers:'.length));
    } else if (line.startsWith('tags:')) {
      current.tags = extractYamlArray(line.slice('tags:'.length));
    } else if (line.startsWith('description:')) {
      current.description = extractYamlValue(line.slice('description:'.length));
    } else if (line.startsWith('rotation_days:')) {
      const val = extractYamlValue(line.slice('rotation_days:'.length));
      if (val) current.rotation_days = parseInt(val, 10);
    }
  }

  if (current?.name) entries.push(finalizeSeedEntry(current));
  return entries;
}

function extractYamlValue(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractYamlArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function finalizeSeedEntry(partial: Partial<SeedEntry>): SeedEntry {
  return {
    name: partial.name ?? '',
    value: partial.value ?? '',
    consumers: partial.consumers ?? [],
    tags: partial.tags ?? [],
    description: partial.description,
    rotation_days: partial.rotation_days,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * True when the current module was invoked directly as a script (vs imported).
 * Resolves symlinks on both sides so `npm link` shims (e.g. `.../bin/gateway`
 * → `dist/cli.js`) are recognized as a direct invocation.
 */
export function isDirectInvocation(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  program.parseAsync(process.argv).catch((err: Error & { code?: string; exitCode?: number }) => {
    // exitOverride() makes Commander throw on --help, --version, and parse
    // errors. Help and version aren't errors — exit cleanly. Parse errors
    // (unknown command, missing arg) have already been printed by Commander.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return;
    if (err.code?.startsWith('commander.')) {
      process.exit(err.exitCode ?? 1);
    }
    console.error(err.message);
    process.exit(1);
  });
}
