# Security

CipherGate stores credentials. Please treat findings accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (Security → Report a vulnerability), which opens a channel only
maintainers can see.

Please include what you need to make the finding reproducible: the version or
commit, the request or command, and what you observed versus what you expected.
A proof of concept helps and is welcome.

This is a personal project maintained in spare time. You should expect an
acknowledgement within a week. If a report is valid I would rather fix it
properly than quickly, and I will tell you where it stands rather than go quiet.

## What is in scope

Anything that lets a party read or write a secret they should not, or that puts
plaintext somewhere it should not be:

- Bypassing consumer authorization on the REST API or MCP surface
- Bypassing the browser UI's session gate
- Plaintext reaching a log, an error message, an audit entry, or a UI response
- Weaknesses in the encryption or key derivation as implemented
- The scoped-injector proxy leaking an injected credential to the downstream
  process, or the guard failing open on a denied tool call

## What is out of scope

- Anything requiring the attacker to already hold the master keyfile. The keyfile
  is the root of trust; if it is compromised, everything is.
- Anything requiring an existing admin consumer key or a valid UI session. Those
  are trusted by design.
- The self-signed certificate warning on the UI listener. That is expected — see
  `DECISIONS.md` for why TLS is scoped the way it is.
- Denial of service by resource exhaustion against a self-hosted single node.
- Missing hardening that is documented as absent rather than claimed as present.

## Threat model, briefly

CipherGate assumes a **trusted operator and a semi-trusted network**. It is built
for a single node you control, serving consumers you configure.

Secrets are encrypted at rest with AES-256-GCM. The data encryption key is
derived from a keyfile via Argon2id. The keyfile is not stored in the database and
must be protected by the filesystem — anyone who can read it can read every
secret.

Consumers authenticate with bearer API keys, stored only as SHA-256 hashes.
Authorization is per-secret: a consumer sees only secrets naming it, except an
admin, which sees everything. Every access is audit-logged.

The REST API defaults to plain HTTP because its consumers are expected to be on a
trusted network. If yours are not, terminate TLS in front of it. The browser UI
gets its own listener, its own credential, and TLS by default, because it is the
highest-value target in the system: it can read and write metadata for every
secret in the store.

**What CipherGate does not do:** no HA, no clustering, no dynamic secrets, no PKI,
no SSO, no multi-tenancy. It is a single-node store. If you need those, use Vault
or OpenBao.
