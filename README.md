# catena-x402-metered-agent-demo

A metered agent that consumes a real pay-per-request x402 endpoint
(BlockRun's image-generation API on Base Sepolia; the chat API is one env
var away) and pays each call from a Catena account, with a configured spend
cap enforced before any money moves.

Each call follows the x402 cycle: request → 402 challenge → pay → retry →
response. The runner drives repeated calls, tracks a running spend total in
exact bigint micro-dollars, and refuses the first call that would push the
total past the cap. Payments draw from a Catena-governed wallet account, so
the platform's own controls (counterparty allowlist, spend limits, approval
thresholds) rule every spend independently of this repo's bookkeeping.

## How a call works

1. **Quote unpaid.** POST the request without payment; decode the price from
   the 402 challenge's `PAYMENT-REQUIRED` header. Nothing is charged.
2. **Cap check.** If `total + price > SPEND_CAP_USD`, refuse before paying.
3. **Pay via the Catena CLI.** `catena x402 --account ... --maxAmount ...`
   pays the challenge from the Catena account; the CLI's `--maxAmount` caps
   the single call as defense in depth. A charge over the policy's approval
   threshold parks as an intent for a human to approve instead of paying.
4. **Deliver.** Async endpoints answer the paid retry with a queued job;
   the agent polls it with the payment's own signature (read back via
   `catena intents get`) until the result is delivered. The seller settles
   on the completing poll: pay-on-delivery.
5. **Reconcile.** "Paid" in the x402 exchange is an authorization, not
   settled funds. The agent reads the intent back and reports the inner
   transaction's status; a seller that fails to deliver leaves a failed
   intent and Catena releases the reserved funds.

## Setup (sandbox, ~10 minutes)

Requires Node >= 22.13, pnpm, and the released Catena CLI
(`npm i -g @catena/cli`, v0.3.0+), linked to your sandbox
(`catena link`).

```sh
pnpm install
cp .env.example .env   # set CATENA_ACCOUNT_ID (accounts list) and CATENA_PROFILE
```

One deliberate, policy-gated step: save the endpoint's receiving address as a
counterparty and allow it in your policy (Catena never auto-adds a 402's
`payTo`). The runner prints the exact command when it is missing:

```sh
catena counterparties create wallet --name 'BlockRun testnet' \
  --address '0xe9030014F5DAe217d0A152f02A043567b16c1aBf' --network base-sepolia
```

## Run

```sh
pnpm run:metered -- --calls 2 --prompt "a robot paying a toll booth"
```

Default run: each call pays ~$0.021 of testnet USDC for one gpt-image-1
generation and prints the delivered image URL, the settlement status and the
running total. Lower `SPEND_CAP_USD` (or raise `--calls`) to watch the cap
bind: the first call that would exceed it is refused before payment. For the
chat flow set `ENDPOINT_KIND=chat`,
`ENDPOINT_URL=https://testnet.blockrun.ai/api/v1/chat/completions` and
`MODEL=openai/gpt-oss-20b`.

**Approval-threshold demo:** in the Catena console open Governance >
Policies > your policy > "Send money" > Rules > "+ Add rule" and set an
approval threshold below the price of a call (e.g. $0.015 with the $0.021
image price). Run once: the CLI parks the payment as a pending intent
instead of paying, and it appears under Governance > Approvals. Approve it,
re-run the same command, and the retry consumes the approval.

## Tests

`pnpm test` — unit and integration tests run against a local fake 402
endpoint and a stub CLI binary; they never touch the network or move money.
`pnpm lint`, `pnpm typecheck`, `pnpm format:check` complete the CI gate.

## Scope

This repo consumes public surfaces only: the public x402 flow of a third-party
endpoint, and the released Catena CLI as a customer payment surface. It does
not implement, reproduce, or reach into Catena's policy engine, platform core,
or SDK internals; the spend meter here is client-side bookkeeping, and the
authoritative controls stay on the platform side.
