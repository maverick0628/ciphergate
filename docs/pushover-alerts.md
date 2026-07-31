# Pushover Audit Alerts

The CipherGate pushes audit events to [Pushover](https://pushover.net) so you get push notifications on your phone/desktop when sensitive things happen. Every audit event is logged to the SQLite audit table regardless — Pushover is just the push channel.

## Quick start

Enable Pushover alerts in `docker-compose.yml`:

```yaml
environment:
  - GATEWAY_PUSHOVER_ENABLED=true
  - PUSHOVER_APP_TOKEN=${PUSHOVER_APP_TOKEN}
  - PUSHOVER_USER_KEY=${PUSHOVER_USER_KEY}
```

`PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY` are injected as environment at deploy time — they are never committed. Defaults give you high-priority alerts for auth failures, deletes, and rotations, and silence the noisy events (reads, lists, creates).

## How it works

The gateway POSTs to `https://api.pushover.net/1/messages.json` with form fields:

| Field | Value |
|---|---|
| `token` | Your Pushover application token (`PUSHOVER_APP_TOKEN`) |
| `user` | Your Pushover user or group key (`PUSHOVER_USER_KEY`) |
| `title` | Short event title, e.g. `CipherGate — Auth failure` |
| `message` | Event detail, with secret values masked |
| `priority` | `1` for high-severity events, `0` for normal events |

The push is fire-and-forget — a Pushover outage never blocks or crashes the gateway, and the event is still written to the audit table.

## Event types and default behavior

| Event | Triggered by | Default alert? | Pushover priority | Why |
|---|---|---|---|---|
| `auth_failure` | Invalid/expired API key, rate-limit lockout | ✅ Yes | `1` (high) | Possible attack or expired consumer |
| `delete` | Secret removed | ✅ Yes | `1` (high) | Destructive, irreversible |
| `update` | Secret value rotated or metadata changed | ✅ Yes | `0` (normal) | Rotation events matter for compliance |
| `rotation_warning` | Scheduled rotation overdue | ✅ Yes | `1` (high) | Security hygiene |
| `create` | New secret added | ❌ No | `0` (normal) | Normal operation, can spam |
| `read` | Secret value retrieved | ❌ No | `0` (normal) | Happens constantly, too noisy |
| `list` | Secret names enumerated | ❌ No | `0` (normal) | Happens during normal CLI use |

### Priority mapping

The gateway keeps an internal five-level severity scale (`min`, `low`, `default`, `high`, `max`) for the threshold filter, then collapses it to Pushover's `-2..2` priority scale at send time:

- Internal `high` or `max` → Pushover priority `1` (bypasses the user's quiet hours)
- Everything else → Pushover priority `0` (normal)

So `auth_failure`, `delete`, and `rotation_warning` arrive as priority `1`; everything that gets alerted otherwise is priority `0`. Emergency priority (`2`, requires acknowledgment) is intentionally not used — it would force a retry loop for routine security events.

## Configuration

All audit alert behavior is controlled via environment variables on the `ciphergate` container.

### Credentials and master toggle

| Env var | Default | Effect |
|---|---|---|
| `GATEWAY_PUSHOVER_ENABLED` | `false` | Master toggle for push alerts |
| `PUSHOVER_APP_TOKEN` | _(empty)_ | Pushover application token |
| `PUSHOVER_USER_KEY` | _(empty)_ | Pushover user or group key |

If either credential is missing, push is skipped even when `GATEWAY_PUSHOVER_ENABLED=true` — audit logging continues unaffected.

### Event-type toggles

Each event type can be turned on or off independently:

| Env var | Default | Effect |
|---|---|---|
| `GATEWAY_ALERT_AUTH_FAILURE` | `true` | Alert on auth failures |
| `GATEWAY_ALERT_DELETE` | `true` | Alert on secret deletions |
| `GATEWAY_ALERT_UPDATE` | `true` | Alert on secret updates/rotations |
| `GATEWAY_ALERT_CREATE` | `false` | Alert when new secrets are created |
| `GATEWAY_ALERT_READ` | `false` | Alert on every secret read (very noisy) |
| `GATEWAY_ALERT_LIST` | `false` | Alert on enumeration (list calls) |
| `GATEWAY_ALERT_ROTATION_WARNING` | `true` | Alert when rotation is overdue |

### Severity threshold

Drop all alerts below a certain internal severity level before they reach Pushover:

```yaml
- GATEWAY_ALERT_MIN_SEVERITY=default
```

Valid values: `min`, `low`, `default`, `high`, `max`.

**Use case:** quiet overnight mode. Set `GATEWAY_ALERT_MIN_SEVERITY=high` and you'll only get alerts for auth failures, deletes, and rotation warnings — never for normal operations.

**Default:** `default` (meaning `default`, `high`, and `max` severity events get through; `low` and `min` are dropped).

### Rate limiting

Prevent notification storms when something goes wrong in a loop:

```yaml
- GATEWAY_ALERT_RATE_LIMIT_MAX=10
- GATEWAY_ALERT_RATE_LIMIT_WINDOW=60
```

Translates to: "send at most 10 Pushover notifications per 60-second window." Events beyond that are dropped (still logged to the audit table, just not pushed).

**Why this matters:** if a rogue service starts hammering the gateway with bad API keys, you'd get 1,000 auth-failure pushes in a minute without rate limiting. With the default config, you get at most 10 — enough to know something's wrong without destroying your phone's battery.

## Recommended profiles

### Quiet homelab (default)

```yaml
- GATEWAY_PUSHOVER_ENABLED=true
- PUSHOVER_APP_TOKEN=${PUSHOVER_APP_TOKEN}
- PUSHOVER_USER_KEY=${PUSHOVER_USER_KEY}
# Everything else uses defaults:
# - auth_failure, delete, update, rotation_warning → alerted
# - create, read, list → silent
# - Rate limit: 10/minute
```

### Paranoid compliance

```yaml
- GATEWAY_PUSHOVER_ENABLED=true
- GATEWAY_ALERT_CREATE=true
- GATEWAY_ALERT_READ=true  # you'll regret this
- GATEWAY_ALERT_LIST=true
- GATEWAY_ALERT_MIN_SEVERITY=min
- GATEWAY_ALERT_RATE_LIMIT_MAX=100
- GATEWAY_ALERT_RATE_LIMIT_WINDOW=60
```

Use this only if you have a downstream consumer of the Pushover messages — a human cannot read every read event.

### Vacation mode (alerts off)

```yaml
- GATEWAY_PUSHOVER_ENABLED=false
```

Events still get logged to the audit table. Check them when you're back:

```bash
gateway audit --last 200
```

### Alerts-only-for-real-problems

```yaml
- GATEWAY_PUSHOVER_ENABLED=true
- GATEWAY_ALERT_MIN_SEVERITY=high
- GATEWAY_ALERT_UPDATE=false   # rotations are routine
- GATEWAY_ALERT_DELETE=true    # deletes are still concerning
```

Result: you only get pinged for auth failures, deletes, and rotation-overdue warnings. Everything else is audit-log-only.

## What gets masked

Audit entries and Pushover messages **never** contain secret values. The logger strips any alphanumeric token 12+ chars long to `first4...last4` format. ISO dates are preserved.

Example sanitization:
- Before: `Consumer 'n8n' read AWS_SECRET_KEY=AKIAIOSFODNN7EXAMPLE`
- After: `Consumer 'n8n' read AWS_SECRET_KEY=AKIA...MPLE`

If you see a full secret value in a Pushover push, **file a bug immediately** — that's a critical leak.

## Testing your configuration

After changing environment variables, restart the gateway:

```bash
docker compose restart ciphergate
```

Trigger test events:

```bash
# Should trigger an auth_failure alert
curl -H "X-API-Key: bogus" http://localhost:8400/api/secrets/ANY

# Should trigger a create alert (if enabled)
gateway secret set TEST_ALERT "hello"

# Should trigger an update alert
gateway secret set TEST_ALERT "world"

# Should trigger a delete alert
gateway secret delete TEST_ALERT
```

Watch the Pushover app on your devices to verify each alert fires (or doesn't, based on your config).

## Routing Pushover messages elsewhere

Pushover delivers to its own apps (iOS, Android, desktop) by default. To fan out:

- **Pushover Groups** — one user key fronting multiple device/user subscriptions
- **Delivery groups** — split critical vs informational by using different application tokens
- **Downstream automation** — n8n or Home Assistant can also call the Pushover API for parallel routing

The gateway only POSTs to the Pushover messages endpoint — everything past that is Pushover's delivery layer.

## Troubleshooting

### I'm not getting any alerts

1. Check `GATEWAY_PUSHOVER_ENABLED=true` is set
2. Check `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY` are both present and valid
3. Check `GATEWAY_ALERT_MIN_SEVERITY` isn't too high
4. Check you're not rate-limited: `GATEWAY_ALERT_RATE_LIMIT_MAX` too low?
5. Check the gateway logs: `docker compose logs ciphergate | grep -i pushover`
6. Verify the token/key directly: `curl -s --form-string "token=$PUSHOVER_APP_TOKEN" --form-string "user=$PUSHOVER_USER_KEY" --form-string "message=test" https://api.pushover.net/1/messages.json`

### I'm getting too many alerts

1. Raise `GATEWAY_ALERT_MIN_SEVERITY` to `high`
2. Disable noisy events: `GATEWAY_ALERT_READ=false`, `GATEWAY_ALERT_LIST=false`
3. Lower `GATEWAY_ALERT_RATE_LIMIT_MAX` if there's an actual event storm

### An alert contains secret values

**Critical bug** — the sanitizer failed. File an issue with:
- The exact message that leaked
- The event type
- The regex pattern that should have caught it

## What's still TODO

- [ ] Alert grouping: collapse repeated auth failures from same IP into one push
- [ ] Quiet hours: suppress normal-priority alerts during overnight window
- [ ] Per-consumer alert routing: different Pushover application tokens based on which consumer triggered the event
- [ ] Alert digest mode: one summary push per hour instead of real-time
