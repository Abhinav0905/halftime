# Contributing to Halftime

Thanks for helping. Halftime is small on purpose, so changes are easiest to review when they are small too.

## Run it locally

```bash
npm install
cp .env.example .env.local   # PayPal sandbox keys are optional; without them payments run in offline demo mode
npm run dev                  # http://localhost:3000
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

- Money is integer cents. Don't introduce floats anywhere money is added, compared or stored.
- The close-out math lives in `lib/engine/` and has no I/O. Add a test in `tests/engine.test.ts` or `tests/rules.test.ts` for any change to it.
- Prices for a PayPal order are always taken from the catalog on the server. The browser only sends SKUs and quantities.
- Notices go to volunteers' friends and neighbours. Keep wording factual and calm: "difference", "recount", never an accusation.
- If you change what a route accepts or returns, update [docs/api-contract.md](docs/api-contract.md) in the same pull request.

For anything larger than a small fix, open an issue first so we can agree on the approach before you write the code.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. Include the PayPal `debug_id` if an API call failed (never paste client secrets).
