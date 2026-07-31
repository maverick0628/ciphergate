import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static assets are served from a fixed allowlist rather than by joining a
 * request path onto a directory. There is no path parameter that reaches the
 * filesystem, so there is no traversal surface to get wrong — which matters
 * more than usual in the process holding every credential.
 */
const ALLOWLIST: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
};

export interface Asset {
  body: Buffer;
  contentType: string;
}

const cache = new Map<string, Asset>();

export function getAsset(name: string): Asset | undefined {
  const contentType = ALLOWLIST[name];
  if (!contentType) return undefined;

  const cached = cache.get(name);
  if (cached) return cached;

  try {
    const path = fileURLToPath(new URL(`./public/${name}`, import.meta.url));
    const asset: Asset = { body: readFileSync(path), contentType };
    cache.set(name, asset);
    return asset;
  } catch {
    return undefined;
  }
}

/** Reset the asset cache. For tests only. */
export function clearAssetCache(): void {
  cache.clear();
}

/**
 * Served at `/` before any UI password exists. An unconfigured install must
 * never present an admin surface, so this is all it gets.
 */
export const BOOTSTRAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CipherGate — setup required</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0d0f12; color: #e6e8eb;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 34rem; padding: 2rem; }
  h1 {
    font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem;
    text-transform: uppercase; letter-spacing: 0.18em;
  }
  .wm { color: #e6e8eb; }
  .wm-b { color: #e02a2a; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: #9aa4b2; }
  p { color: #9aa4b2; margin: 0 0 1rem; }
  code {
    display: block; padding: 0.75rem 1rem; border-radius: 6px;
    background: #171a1f; border: 1px solid #262b33; color: #e6e8eb;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
</head>
<body>
<main>
  <h1><span class="wm">Cipher</span><span class="wm-b">Gate</span></h1>
  <h2>Setup required</h2>
  <p>No UI password is set, so the interface is not available yet. Set one on the gateway host:</p>
  <code>gateway ui set-password</code>
  <p>Then reload this page.</p>
</main>
</body>
</html>
`;
