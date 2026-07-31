/**
 * Offsite object store — Cloudflare R2 (or any S3-compatible endpoint) over the
 * REST API with AWS Signature V4. No SDK dependency: the signer is ~40 lines and
 * fully testable. Path-style addressing (`<endpoint>/<bucket>/<key>`), which R2
 * supports, so a custom endpoint host needs no DNS games.
 *
 * Credentials never come from code — the runner reads `R2_*` from the gateway and
 * passes them in via {@link S3Config}.
 */
import { createHash, createHmac } from 'node:crypto';
import { planRetention, type RetentionPolicy } from './retention.js';

export interface S3Config {
  /** Base endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores region; use 'auto'. S3 needs the real region. */
  region?: string;
}

const SERVICE = 's3';
const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** Derive the SigV4 signing key (AWS4 → date → region → service → aws4_request). */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service = SERVICE): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** RFC-3986 encode a path segment-safe string (S3 leaves '/' unescaped in the URI). */
function uriEncode(str: string, encodeSlash = true): string {
  return str
    .split('')
    .map((ch) => {
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      if (ch === '/' && !encodeSlash) return ch;
      return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign an S3 request. `query` is a record of *unencoded* query params; the
 * canonical query string is built from it. Returns the final URL + headers
 * (including Authorization) ready to hand to fetch.
 */
export function signRequest(
  cfg: S3Config,
  method: string,
  canonicalPath: string,
  query: Record<string, string>,
  body: Buffer,
  now: Date,
): SignedRequest {
  const region = cfg.region || 'auto';
  const host = new URL(cfg.endpoint).host;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join('');

  const canonicalRequest = [
    method,
    uriEncode(canonicalPath, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', deriveSigningKey(cfg.secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  headers['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : '';
  return { url: `${cfg.endpoint.replace(/\/$/, '')}${canonicalPath}${qs}`, headers };
}

type FetchFn = typeof fetch;

const objectPath = (cfg: S3Config, key: string): string => `/${cfg.bucket}/${key}`;

/** PUT an object. Body is raw bytes (already encrypted upstream). */
export async function putObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  opts: { fetchFn?: FetchFn; now?: Date; contentType?: string } = {},
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? new Date();
  const signed = signRequest(cfg, 'PUT', objectPath(cfg, key), {}, body, now);
  if (opts.contentType) signed.headers['Content-Type'] = opts.contentType;
  const res = await fetchFn(signed.url, { method: 'PUT', headers: signed.headers, body: Uint8Array.from(body) });
  if (!res.ok) throw new Error(`PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
}

/** GET an object's bytes. */
export async function getObject(cfg: S3Config, key: string, opts: { fetchFn?: FetchFn; now?: Date } = {}): Promise<Buffer> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? new Date();
  const signed = signRequest(cfg, 'GET', objectPath(cfg, key), {}, Buffer.alloc(0), now);
  const res = await fetchFn(signed.url, { method: 'GET', headers: signed.headers });
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** DELETE an object. */
export async function deleteObject(cfg: S3Config, key: string, opts: { fetchFn?: FetchFn; now?: Date } = {}): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? new Date();
  const signed = signRequest(cfg, 'DELETE', objectPath(cfg, key), {}, Buffer.alloc(0), now);
  const res = await fetchFn(signed.url, { method: 'DELETE', headers: signed.headers });
  if (!res.ok && res.status !== 204) throw new Error(`DELETE ${key} failed: ${res.status}`);
}

/** List object keys under a prefix (ListObjectsV2; follows continuation tokens). */
export async function listObjects(cfg: S3Config, prefix: string, opts: { fetchFn?: FetchFn; now?: Date } = {}): Promise<string[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const now = opts.now ?? new Date();
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const signed = signRequest(cfg, 'GET', `/${cfg.bucket}`, query, Buffer.alloc(0), now);
    const res = await fetchFn(signed.url, { method: 'GET', headers: signed.headers });
    if (!res.ok) throw new Error(`LIST ${prefix} failed: ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = next ? decodeXml(next[1]) : undefined;
  } while (token);
  return keys;
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Apply the retention policy under a prefix: list, decide via {@link planRetention},
 * delete the out-of-window keys. Returns what was pruned (never silent).
 */
export async function pruneRetention(
  cfg: S3Config,
  prefix: string,
  policy: RetentionPolicy,
  opts: { fetchFn?: FetchFn; now?: Date } = {},
): Promise<{ pruned: string[]; kept: string[] }> {
  const keys = await listObjects(cfg, prefix, opts);
  const { keep, prune } = planRetention(keys, policy);
  for (const key of prune) await deleteObject(cfg, key, opts);
  return { pruned: prune.sort(), kept: keep.sort() };
}
