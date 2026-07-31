/**
 * Gateway DB backup — the gateway already encrypts its SQLite store, so backing
 * it up is just capturing that artifact and shipping it offsite. The DB lives
 * inside the gateway container, so the default command execs into it
 * and streams the encrypted file to stdout (no host bind-mount needed):
 *
 *   docker exec ciphergate sh -c 'f=$(mktemp); gateway backup --output "$f" >/dev/null; cat "$f"; rm -f "$f"'
 *
 * The command is config so a different topology (local DB, `docker cp`, a REST
 * backup path) is a config change, not a code change. `capture` is injected for
 * tests; in production it runs the argv and returns stdout bytes.
 */
import { execFile } from 'node:child_process';

export interface GatewayConfig {
  /** argv whose stdout is the encrypted DB artifact. */
  backupCommand: string[];
}

type CaptureFn = (argv: string[]) => Promise<Buffer>;

/** Run an argv and return its stdout as raw bytes (10 MB cap — the DB is small). */
const defaultCapture: CaptureFn = (argv) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`gateway backup command failed: ${err.message}`));
      else resolve(stdout as Buffer);
    });
  });

/** Capture the gateway's encrypted DB artifact. Throws if the command emits nothing. */
export async function backupGateway(
  cfg: GatewayConfig,
  deps: { capture?: CaptureFn } = {},
): Promise<{ data: Buffer; command: string[] }> {
  const capture = deps.capture ?? defaultCapture;
  const data = await capture(cfg.backupCommand);
  if (!data || data.length === 0) {
    throw new Error('gateway backup produced an empty artifact — refusing to ship a zero-byte DB');
  }
  return { data, command: cfg.backupCommand };
}
