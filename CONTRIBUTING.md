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
- The close-out math lives in `lib/engine/` and has no I/O. Add a test there for any change to it.
- Prices for a PayPal order are always taken from the catalog on the server. The browser only sends SKUs and quantities.
- Notices go to volunteers' friends and neighbours. Keep wording factual and calm: "difference", "recount", never an accusation.

## Good first issues

Look for issues labelled `good first issue`. If you want to work on one, comment on it first so two people don't do the same work.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. Include the PayPal `debug_id` if an API call failed (never paste client secrets).
