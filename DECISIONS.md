# Decisions

Why things are the way they are. Newest first.

Operational entries about the private deployment this was extracted from have
been left out. What remains is the reasoning that shaped the code.

## Never gate authentication on a raw URL string

A pre-landing review of the browser UI found an authentication bypass that every
test had missed. The session hook read:

```ts
if (!request.url.startsWith('/api/')) return;
```

`request.url` is the **raw** url, but Fastify's router matches the **decoded**
path. So `GET /%61pi/secrets` routed straight to the handler while the string
check saw no match and skipped the gate entirely. Every secret's name, tags and
consumer list was readable with no session, and any percent-encoding of any
character in the prefix defeated it.

The tests missed it because they all addressed the API with literal paths, which
is exactly the blind spot: they proved the gate works when the attacker spells
the URL the way the developer did.

The API routes now live in an encapsulated Fastify scope that carries the hook,
so Fastify's router decides what is gated. A string comparison against a
user-controlled URL is not an authorization mechanism, and the structural fix
removes the whole class rather than the one encoding.

## Payload types can be an authorization concern

From the same review. Storage persists `consumers` with `JSON.stringify`, and the
REST API authorizes with `secret.consumers.includes(consumerName)`. Given an
array that is correct membership testing; given a **string** it silently becomes
substring matching — so a secret written with `consumers: "claude-code"` would
have granted access to a consumer named `claude`. The UI accepted the string and
stored it.

Writes are now type-validated before reaching storage: `consumers` and `tags`
must be arrays of non-empty strings, `rotation_days` a positive integer or null,
`value` and `description` strings. Everything else is a 400.

## The browser UI is built on PUT, and that is the whole point

`PUT /v1/secret/:name` is a genuine partial update: storage only archives to
history and bumps the version when new ciphertext arrives. The CLI's `secret set`
is an upsert over the same layer, which is why omitting a value there can write
an empty one and destroy the credential.

Editing tags or consumers through the UI therefore cannot touch the stored value.
Consumers keep replace semantics in storage, so the form renders the full set as
pre-populated checkboxes and always submits all of it — "I meant to add one
consumer and dropped the rest" stops being expressible.

## The UI never displays a secret

The detail view shows a mask (`sk-l...c9ae`) and **no UI endpoint returns
plaintext at all**, so a stolen session yields metadata and eight characters
rather than everything. Reading a real value is a CLI or MCP operation.

Deleting is also absent by design. A GUI makes actions easy, which is the last
property an irreversible operation needs.

Computing the mask requires the plaintext, so the detail view genuinely is a read
and is audit-logged as one. The list view returns no masks at all, so browsing
decrypts nothing.

## Green should mean "checked and fine"

`computeRotationStatus` reports `ok` when `rotation_days` is null. That made a
secret nobody is watching render identically to one being actively checked — and
most secrets have no rotation policy, so the reassurance was mostly false.

`listSecretsForUi` adds a `none` state, rendered as a hollow dot. The REST API's
shape is deliberately untouched.

## Two accent colours, doing different jobs

`--brand` is identity. `--accent` is amber and is *semantic*: it appears only
where a stored value is at risk — rotation overdue, the rotate compartment.
Keeping them separate is what lets the amber rule keep meaning something.

## No downloaded fonts, no external requests

The UI is served by the process holding every credential, on a network that may
have no route out. A webfont request would be both a phone-home and a hard
dependency on the internet being up. The mark is inline SVG; the wordmark's
character comes from caps and tracking.

Asserted in tests rather than left to discipline, alongside no `localStorage`, no
`innerHTML`, and no external loads.

## TLS on the UI listener only

Enabling TLS on the API port is not free: consumers address it over plain HTTP,
and a self-signed certificate is rejected by most clients unless verification is
disabled — which is worse than plain HTTP on a trusted network.

The UI listener has no such consumers, and it is where the exposure actually is:
writing a secret sends plaintext from the browser. It generates a self-signed
certificate into the data directory on first start, and falls back to HTTP with a
warning rather than refusing to boot. A broken certificate should degrade, not
take the UI offline at the moment someone needs to rotate a credential.

The session cookie's `Secure` flag is conditional on the listener actually
serving HTTPS. Setting it unconditionally would make login fail silently in that
fallback, because the browser would never send the cookie back.

## Don't use magic OS paths as test fixtures

CI once hung for ten minutes on a suite that runs in seven seconds locally. A test
passed `/proc/nonexistent-and-unwritable` as a stand-in for "certificate
generation is impossible". macOS has no `/proc`, so it failed instantly and the
suite was green; on Linux `mkdirSync(path, { recursive: true })` against that
procfs path never returned.

The fix removed two defects. The `mkdir` was dead defensiveness — the data
directory necessarily exists, because SQLite already opened a database inside it.
And the test now uses a regular file as the directory, so any write beneath it
fails `ENOTDIR` instantly on every platform.

The general rule: a fixture that depends on a path the OS treats specially is not
portable, and "green locally" says nothing about the platform CI runs on.

## CI builds the image, because nothing else catches a build-context error

`npm run build` gained a dependency on `scripts/copy-ui-assets.mjs`, which the
Dockerfile's builder stage did not copy. A local build and the test job both
passed, because both have the whole repo on disk. Only the image has a restricted
context, and the failure surfaced at deploy time.

CI now builds the image and asserts it ships the UI assets, `openssl`, and the
`ui set-password` command.

## Hidden prompts must survive readline's repaint

`gateway ui set-password` looked hung on a real terminal. It was reading input
with an invisible prompt.

readline repaints the whole line on every keystroke in terminal mode, and the
repaint begins by clearing to end of screen — so a prompt written with
`process.stdout.write` *before* `question()` is erased by the first repaint.
Muting `_writeToOutput` stops the echo of typed characters but not the clear,
which is issued directly against the output stream.

readline now owns the prompt, and its renderer repaints the prompt rather than
the buffer. No test caught this because the suite drives those helpers through
pipes, where readline never enters terminal mode.

## Serialize the native build

Alpine is musl, so `better-sqlite3` has no usable prebuild and node-gyp compiles
from source at `make -j<nproc>`. On a small host that parallel spike can OOM at
the wrong instant. `ENV JOBS=1` costs a couple of minutes and removes the risk.
