#!/usr/bin/env node
//
// Automated offsite backups — `gateway-backup`.
//
// Snapshots the Qdrant collections, the gateway's encrypted DB, and the Letta
// agents; encrypts what isn't already encrypted; uploads to R2 under
// `<asset>/<date>/…`; writes a manifest; and prunes retention. See
// docs/backups.md.
//
//   gateway-backup run                          # one full backup
//   gateway-backup restore <asset> <date>       # dry-run: list what WOULD restore
//   gateway-backup restore qdrant <date> \
//     --collection claude-memory --execute      # recover into a SCRATCH collection
//
// Config is env-driven with homelab defaults — see src/backup/config.ts.
//   BACKUP_QDRANT_URL, BACKUP_COLLECTIONS, BACKUP_LETTA_URL/KEY,
//   R2_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY, BACKUP_ENCRYPTION_KEY,
//   BACKUP_RETAIN_DAILY/WEEKLY, BACKUP_GATEWAY_CMD, BACKUP_STATE

import { Command } from 'commander';
import { backupConfigFromEnv } from './backup/config.js';
import { runBackup, summarizeBackup } from './backup/runner.js';
import { listRestorable, restoreQdrantCollection, scratchName } from './backup/restore.js';

const program = new Command();
program.name('gateway-backup').description('Automated, encrypted, offsite, restore-tested homelab backups');

program
  .command('run')
  .description('Run one full backup: snapshot + encrypt + upload + manifest + prune')
  .action(async () => {
    const cfg = backupConfigFromEnv();
    const manifest = await runBackup(cfg);
    console.log(summarizeBackup(manifest));
    for (const asset of manifest.assets) {
      console.log(`  ✓ ${asset.type.padEnd(8)} ${asset.key}  ${(asset.size / 1024).toFixed(1)} KiB${asset.count != null ? `  (${asset.count} pts)` : ''}`);
    }
    for (const err of manifest.errors) console.error(`  ! ${err}`);
    process.exit(manifest.errors.length ? 1 : 0);
  });

program
  .command('restore <asset> <date>')
  .description('Restore from a backup. Dry-run by default; --execute to actually recover.')
  .option('--collection <name>', 'qdrant: the collection to recover (required with --execute)')
  .option('--scratch <name>', 'override the scratch collection name')
  .option('--execute', 'actually perform the restore (default is a dry-run listing)', false)
  .action(async (asset: string, date: string, opts: { collection?: string; scratch?: string; execute: boolean }) => {
    const cfg = backupConfigFromEnv();

    if (!opts.execute) {
      const keys = await listRestorable(cfg.store, asset, date);
      if (!keys.length) {
        console.log(`No ${asset} objects found for ${date}.`);
        process.exit(1);
      }
      console.log(`Dry-run — restoring ${asset}/${date} would touch:`);
      for (const key of keys) console.log(`  ${key}`);
      if (asset === 'qdrant') {
        const into = opts.collection ? scratchName(opts.collection, date) : '<collection>__restore_' + date.replace(/-/g, '_');
        console.log(`\nRe-run with --collection <name> --execute to recover into a scratch collection (e.g. ${into}).`);
      }
      process.exit(0);
    }

    if (asset !== 'qdrant') {
      console.error(`--execute restore is only implemented for 'qdrant' (gateway/letta restore is a manual reload from the downloaded artifact).`);
      process.exit(2);
    }
    if (!opts.collection) {
      console.error('--collection <name> is required with --execute');
      process.exit(2);
    }
    const out = await restoreQdrantCollection(
      { store: cfg.store, qdrant: cfg.qdrant, encryptionKey: cfg.encryptionKey },
      date,
      opts.collection,
      { scratch: opts.scratch },
    );
    console.log(`Recovered ${out.source} → scratch collection ${out.scratch}: ${out.count} points.`);
    console.log('Verify the count matches the source, then drop the scratch collection when done.');
    process.exit(0);
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`[gateway-backup] ${(err as Error).message}\n`);
  process.exit(1);
});
