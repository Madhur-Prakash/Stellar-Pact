# StellarPact — frontend

The Next.js app for [StellarPact](../README.md), an on-chain milestone escrow
system on Stellar. Start at the [root README](../README.md) for the contracts,
the architecture and the deployment story; this file covers only the app.

Live: **https://stellar-pact-pi.vercel.app**

## Run it

Node 22+. Nothing else — Rust and the Stellar CLI are only needed to build or
deploy the contracts.

```sh
cp .env.example .env.local     # already points at the live testnet contracts
npm install
npm run dev
```

Open http://localhost:3000. Reading the deal list needs no wallet; taking an
action needs a testnet wallet funded from [friendbot](https://friendbot.stellar.org).

## Scripts

| | |
|---|---|
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run lint` | ESLint — Next 16 removed linting from `next build`, so this is separate |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:run` | Vitest, once |
| `npm test` | Vitest, watch |

## Environment

Five variables are required; [`.env.example`](.env.example) carries the values
for the live deployment, and the [root README](../README.md#deploying-the-contracts)
explains where they come from. Two more are optional — their defaults are derived
from the network name, so they are only needed to point at a private endpoint.

Every `NEXT_PUBLIC_*` value is inlined at **build** time, so changing one means
rebuilding rather than restarting. `scripts/deploy.sh` regenerates `.env.local`
automatically; on a host, set them in the project's own environment.

## Layout

```
src/
  lib/          config · format · errors · stellar · contracts · events · deal
  hooks/        data loading, polling, the shared write pipeline
  context/      wallet and toast providers
  components/   dashboard, value bar, activity tape
```

`lib/` holds everything that can be reasoned about without React, which is where
the tests live: stroop maths, which actions a deal offers, what a failure means,
and the decoders. Reads are simulations against a null source account — no
wallet, no fee. Writes run one pipeline: simulate, assemble, sign, submit, poll.

Type is Archivo for the interface and IBM Plex Mono for every exact on-chain
quantity, so anything that came off the chain looks like it.

## Tests

```sh
npm run test:run
```

86 tests over the pure logic. `vitest.config.mts` loads the `.env` files the way
Next does, so `config.test.ts` asserts against the real deployment values —
including that the network passphrase survives its semicolon, which a careless
parser would truncate into signatures the network rejects.
