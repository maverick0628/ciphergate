# MCP guardrails

Real, fail-closed enforcement on the genuinely risky MCP servers — `coinbase`
and `robinhood-trading` — built on the existing `gateway-proxy guard`. Reads and
quotes pass; orders, transfers, and cancellations are **denied by default**;
balances and keys are redacted; every block fires a push notification.

This replaces the old `protect-mcp` plugin and the `~/.coinbase-guardrails/` /
`~/.robinhood-guardrails/` `guardrail.py` PreToolUse hooks, which failed open
(an error in the hook let the call through).

## Why the guard, not a hook

A PreToolUse hook is advisory and out-of-band: if it errors, times out, or is
misconfigured, the tool call still happens. The guard is **in-band** — it sits in
the JSON-RPC stream between Claude and the downstream server, so a denied call
**never reaches** the exchange. Default-deny means a tool the policy doesn't know
about is blocked until you add it, not allowed until you notice.

```
Claude ──stdio──▶ mcp-wrap ──▶ gateway-proxy guard coinbase ──▶ coinbase MCP ──▶ Coinbase API
                                   │  allowlist filter
                                   │  deny + Pushover alert on a trade
                                   └  redact balances/keys on the way back
```

## Decision tiers

| Tier | Meaning | How it's expressed |
|---|---|---|
| **allow** | read-only / non-sensitive | listed in `allowTools` |
| **redact** | allowed, but scrub fields from the response | listed in `allowTools` **and** matched by `redactPatterns` |
| **deny** | money-moving / destructive | **omitted** from `allowTools` (default-deny) |

There is no soft "warn-and-allow" tier for trades — omission is a hard block.
(`warnArgPatterns` still exists for credential-shaped arguments, inherited from
the engine defaults.)

## The policies

Authored as standalone, reviewable files loaded by the existing policy engine:

- [`policies/coinbase.policy.json`](../policies/coinbase.policy.json) — allows
  `coinbase_products_*`, `coinbase_orders_list/get/fills/preview`,
  `coinbase_convert_quote/get`, `coinbase_portfolios_list/get`, `coinbase_fees`,
  `coinbase_help`, and `coinbase_balance`. Denies (by omission)
  `coinbase_orders_create/edit/cancel/close_position`, `coinbase_convert_execute`,
  `coinbase_transfer`, `coinbase_portfolios_create/edit/delete`, `coinbase_set_env`.
  Redacts API keys and balance objects.
- [`policies/robinhood-trading.policy.json`](../policies/robinhood-trading.policy.json) —
  allows the `get_*` reads, `review_equity_order` / `review_option_order`
  (non-executing previews), `search`, and the scan reads. Denies `place_*_order`,
  `cancel_*_order`, and the watchlist/scan mutations. Redacts account numbers and keys.

A policy file is referenced from the proxy manifest with `policyFile` (mutually
exclusive with an inline `policy`); the path resolves relative to the manifest.

## Wire it up

1. **Add the servers to your proxy manifest** (see
   [`proxy-manifest.example.json`](../proxy-manifest.example.json)) with the real
   launch command/args and the gateway secret names each needs:

   ```jsonc
   "coinbase": {
     "command": "<your coinbase mcp launch command>",
     "args": [],
     "secrets": { "COINBASE_API_KEY": "COINBASE_API_KEY", "COINBASE_API_SECRET": "COINBASE_API_SECRET" },
     "policyFile": "policies/coinbase.policy.json"
   }
   ```

2. **Point Claude at the guard, not the raw server**, in `~/.claude.json`. The
   guard injects the credentials from the gateway *and* enforces the policy, so
   the keys never live in Claude's config:

   ```jsonc
   "coinbase": {
     "command": "gateway-proxy",
     "args": ["guard", "coinbase"],
     "env": {
       "GATEWAY_PROXY_KEY": "sg_live_<coinbase-consumer-key>",
       "PUSHOVER_TOKEN": "<pushover app token>",
       "PUSHOVER_USER": "<pushover user key>"
     }
   }
   ```

   (`GATEWAY_PROXY_MANIFEST` points the proxy at your manifest if it isn't
   `./proxy-manifest.json`. `PUSHOVER_TOKEN`/`PUSHOVER_USER` enable the deny
   alert; `GUARD_NTFY_URL` optionally mirrors it to ntfy.)

3. **Remove the old hooks.** Once the guard is in place, delete the
   `protect-mcp` plugin config and the `coinbase`/`robinhood-trading` PreToolUse
   entries pointing at `guardrail.py`. The allowlist is a superset of what those
   checks blocked, enforced in-band.

## Verify (acceptance)

Drive the real server through the guard once:

```bash
# tools/list is filtered to the allowlist (no order/transfer tools appear)
gateway-proxy guard coinbase   # then, from an MCP client, list tools

# a read works
#   call coinbase_products_ticker  → returns a price
# a trade is blocked + alerts
#   call coinbase_orders_create    → "Blocked by gateway-proxy guard: tool ... not in the allowlist"
#                                     and a Pushover push fires; the call never hits Coinbase
```

1. A read succeeds; a trade is denied and a Pushover alert fires. ✅
2. Balances/keys are `[REDACTED]` in an allowed read. ✅
3. A brand-new server tool is denied until added to `allowTools`. ✅
4. The `guardrail.py` hooks can be removed with no loss of coverage. ✅

The deterministic version of 1–3 lives in
[`tests/proxy-guardrails.test.ts`](../tests/proxy-guardrails.test.ts), which runs
the shipped policy files through the real guard bridge against a fake exchange.

## Adding another risky server

1. Write `policies/<server>.policy.json` — start from `allowTools: []` (deny
   everything) and add back only the read tools you've confirmed are safe.
2. Reference it with `policyFile` in the manifest; launch via
   `gateway-proxy guard <server>` in `~/.claude.json`.
3. List the tools through the guard and confirm only the safe ones appear.

## Security notes

- **Fail-closed.** An unknown tool, a guard misconfig, or a downstream that adds
  a new tool all result in *denial*, not exposure.
- **Credentials stay in the gateway** — the guard injects them into the child at
  launch; Claude only holds the scoped consumer key.
- **Redaction is regex over response text** — it scrubs the configured fields but
  isn't a substitute for least-privilege API keys. Use read-only exchange keys
  where the API supports them.
- Deny alerts are best-effort (Pushover + optional ntfy); a notification outage
  never changes the deny decision.
