# Contributing

This is a personal project published as a reference implementation. It is not
chasing adoption, and it is not a product. That shapes what is useful to send.

**Security findings do not belong here.** See [SECURITY.md](SECURITY.md) and use
private reporting.

## What is genuinely welcome

- Bug reports with a reproduction — the version or commit, what you ran, what
  happened, what you expected
- Corrections where the docs and the code disagree
- Portability fixes, particularly on platforms other than macOS and Linux

## What is likely to be declined

- New runtime dependencies. There are five, deliberately.
- Features that widen the scope past storing and serving secrets. Retrievers,
  knowledge tooling and integrations with specific products were removed from
  this repo on purpose.
- HA, clustering, dynamic secrets, PKI, SSO, multi-tenancy. If you need those,
  Vault and OpenBao already do them well.
- Large refactors without a bug behind them.

## Before opening a PR

```bash
npm test
npm run build
docker build -t ciphergate:ci .
```

All three. The image has a restricted build context, so a green test run does not
mean the image builds — that gap has bitten before.

Read [AGENTS.md](AGENTS.md) first. It lists the rules that are load-bearing and
the reasons behind them, most of which exist because something went wrong once.
[DECISIONS.md](DECISIONS.md) has the incidents in full.

Match the surrounding style. Comments explain why, not what.
