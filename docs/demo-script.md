# Demo script (3-5 min Loom)

Target: normal metered calls, the behavior at the configured cap, and the
approval-threshold flow, per the acceptance criteria.

Prep (off camera): `.env` set (`CATENA_ACCOUNT_ID`, `CATENA_PROFILE`),
`pnpm install` done, Catena console open on Governance > Policies and
Governance > Approvals in background tabs. IMPORTANT: remove or raise the
Approval threshold rule above $0.021 before Scene 2, so normal calls do not
park; you will add it back on camera in Scene 4.

## Scene 1 - What this is (30s)

README top. Say:

> A metered agent consuming a real pay-per-request x402 endpoint, BlockRun's
> image API on Base Sepolia, paying each call from a Catena account through
> the released CLI. A spend cap binds before any money moves, and the
> platform's own policy rules bind independently of anything this code does.

## Scene 2 - Normal metered calls (60s)

```sh
pnpm run:metered -- --calls 2 --prompt "a robot paying a toll booth"
```

Point at each line: `paid $0.021 (intent completed) -> https://...png`.
Open one image URL. Say:

> Each call is quoted unpaid from the 402 challenge first, then paid, then
> reconciled: "paid" in the x402 exchange is an authorization, so the agent
> reads the payment intent back and reports whether funds actually settled.
> BlockRun settles on delivery, which we can see as "intent completed".

## Scene 3 - The cap binds (45s)

```sh
SPEND_CAP_USD='$0.045' pnpm run:metered -- --calls 3
```

Calls 1-2 pay ($0.042 total), call 3 is REFUSED before payment. Point at:

- `REFUSED before payment: next call costs $0.021 but only $0.003 of the cap remains`
- `Settlement: 2 completed` and the clean exit

Say: the refusal happens before the CLI is ever invoked; the tests prove
that by asserting the payment binary never ran.

## Scene 4 - Over the approval threshold (90s)

In the console: Governance > Policies > policy > Send money > Rules >
Add rule > Approval threshold, set $0.015. Then:

```sh
pnpm run:metered -- --calls 1
```

Point at: `PARKED for human approval (intent int_...)` and the printed
policy reason (`amount $0.021 against threshold $0.015`), and
`Spend: $0 ... no payments`. Switch to Governance > Approvals, show the
pending intent, approve it. Re-run the exact same command:

```sh
pnpm run:metered -- --calls 1
```

The retry consumes the approval: `paid $0.021 (intent completed)` and the
delivered image. Say:

> The threshold lives in Catena's policy engine, not in this repo. The
> agent's own bookkeeping could be wrong or malicious and the parked
> payment would still wait for a human.

## Scene 5 - Close (30s)

Catena console transactions view: the settled payments to the BlockRun
counterparty. Closing line:

> Spend controls in two layers: client-side bookkeeping for fast refusals,
> platform policy as the real boundary. Everything through public
> surfaces: the released CLI and the public x402 flow.
