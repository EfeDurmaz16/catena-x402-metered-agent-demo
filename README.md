# catena-x402-metered-agent-demo

A metered agent that consumes a real pay-per-request x402 endpoint
(BlockRun's `/chat/completions` on Base Sepolia) and pays each call from a
Catena account, with a configured spend cap enforced before any money moves.

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
4. **Record.** The settled amount reported by the CLI is added to the total.

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
pnpm run:metered -- --calls 3
```

Normal run: each call settles ~$0.001 of testnet USDC and prints the running
total. Raise `--calls` (or lower `SPEND_CAP_USD`) to watch the cap bind: the
first call that would exceed it is refused before payment, and the runner
exits cleanly stating what was spent and why it stopped.

**Approval-threshold demo:** set your policy's automatic-approval threshold
below the price of a call, run once, and the CLI parks the payment as a
pending intent instead of paying. Approve it in the Catena console, re-run
the same command, and the retry consumes the approval.

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
