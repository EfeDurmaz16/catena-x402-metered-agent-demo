# Architecture

One paid call, end to end:

```
runner --> agent: quote unpaid (402 header)  --> cap check (bigint micros)
                                                  |
                                   refuse before payment when over cap
                                                  |
        catena x402 --account ... --maxAmount min(per-call, remaining cap)
                                                  |
        Catena policy engine: counterparty allowlist, rules, approval threshold
                                                  |
              paid retry --> BlockRun --> 202 queued job + poll_url
                                                  |
        poll with the payment's own signature (catena intents get)
                                                  |
              delivery --> seller settles on the completing poll
                                                  |
        reconcile: intents get -> inner transaction status -> report
```

## Where enforcement lives

Two independent layers, by design:

- **Client-side bookkeeping (this repo).** The meter counts authorized
  amounts in exact bigint micro-dollars and refuses a call before payment
  when it would pass `SPEND_CAP_USD`. The CLI authorization is clamped to
  the remaining budget, so even a challenge that changed after the quote
  cannot push the total past the cap. This layer is convenience and
  fast feedback; it is not the security boundary.
- **Platform-side policy (Catena).** The account's policy rules bind every
  spend regardless of what this process does: counterparty allowlist
  (payTo must be saved and allowed), and rule types configured in the
  console (per-transaction limit, daily/weekly/monthly spending limits,
  hourly/daily transaction limits, approval threshold). An over-threshold
  payment parks as an intent for a human; re-running the same command
  consumes the approval.

## Payment truth has three stages

The demo treats these as distinct, because they are:

1. **Authorized** - the x402 exchange succeeded and the CLI reports `paid`.
   Funds are reserved, not moved.
2. **Delivered** - the endpoint produced the result. BlockRun settles on
   the completing poll (pay-on-delivery); an endpoint that fails after
   authorizing never settles, Catena marks the intent failed and releases
   the funds (observed live against a broken upstream).
3. **Settled** - the intent's inner transaction reports completed. The
   agent reads this back with `catena intents get` after every payment and
   the runner prints a per-status tally rather than assuming success.

A charged-but-undelivered call is always surfaced as `paid_but_error` and
the runner exits non-zero; an unreadable poll response is retried, never
mistaken for a delivered body.

## Why `exact`, and what `upto` would change

The x402 scheme in production today is `exact`: the price is fixed by the
challenge before the call runs. True usage-based metering (settle actual
consumption up to a signed maximum) is the `upto` scheme, which exists as a
spec draft but has no facilitator or SDK implementation yet. Providers
bridge the gap by flat-pricing per request (BlockRun testnet) or pricing
the maximum envelope. This demo's metering - fixed-price calls behind a
running cap - is how the ecosystem meters today; when `upto` lands, the
same cap logic applies to the authorized maximum instead of a fixed price.

## Known limits

- **At-most-once, no idempotency key.** If the CLI is killed mid-payment
  the intent may already be in flight; the wrapper says so and points at
  the console instead of retrying blindly. Production would derive an
  idempotency key from the payment authorization.
- **Single-process meter.** The spend total lives in one process; the
  platform-side rules are what bind across processes and machines.
- **BlockRun testnet upstreams vary.** Chat models currently fail after
  authorization (upstream credential errors, reported to BlockRun);
  OpenAI image models deliver. The endpoint, model and kind are env
  configuration, so a fixed upstream is a `.env` change away.
