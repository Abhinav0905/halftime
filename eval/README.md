# Photo count evaluation

The only model in Halftime suggests item counts from a photo of the table. A volunteer confirms every number, and PayPal's itemized sales flag a recount when a closing count is impossible. This folder measures how often the suggestion is right before anyone has to correct it.

## What is here

| Path | What it is |
|---|---|
| `photos/` | Your test photos. Not committed (see `photos/README.md`). |
| `labels.example.json` | The label format. Copy it to `labels.json` and fill in your own counts. |
| `labels.json` | Hand counts for each photo: `{ "<file>": { "<sku>": count } }`. Any item you leave out counts as 0. |
| `recorded/<sha256>.json` | Saved model answers for the demo photos, keyed by the photo's SHA-256. Replay mode uses these so the app works with no API key. |
| `results.json` | Written by each run: per-photo counts, errors and the summary. |

## Shooting the photos

Use the five menu items from the sample club (water bottles, sports drinks, chip bags, candy bars, foil-wrapped hot dogs) and a phone camera.

- **3 layouts × 2 lighting conditions**, at least one photo each. More is better; 10 per combination gives a useful number.
  - Layouts: (a) neat rows with gaps, (b) grouped by item and touching, (c) a realistic mixed table with some items partly hidden.
  - Lighting: (1) even indoor or shade light, (2) harsh or mixed light (gym lights, low sun, glare on bottles).
- Lay everything flat on one table. Hold the phone straight above it so the whole table is in frame, with a little margin.
- Turn labels away from the camera or cover brand marks, so the photos can be shown publicly.
- Shoot a few closing-style photos too: fewer items, some knocked over, an empty patch of table.
- Keep the files as the phone saves them, or export at 1600 px on the long edge. For photos used in the live demo, use JPEG at 1600 px or less and under 2.5 MB: the app uploads those unchanged, so their SHA-256 matches the recording and replay mode finds them.

## Labelling

Count each photo by hand, twice, ideally by two people, and settle any disagreement by looking again. Write the result into `labels.json`:

```json
{
  "rows-shade-01.jpg": { "water": 12, "sports": 6, "chips": 10, "candy": 8, "hotdog": 0 }
}
```

Count a unit if any part of it is visible. Do not count items still inside a closed case.

## Running

```sh
npm run eval                            # configured provider (Gemini if GEMINI_API_KEY is set)
npm run eval -- --model gemini-3.5-flash
npm run eval -- --only rows-shade-01.jpg
npm run eval -- --record                # also save answers to recorded/ for replay mode
npm run eval -- --provider replay       # score the saved answers; no key needed
npm run eval -- --photos ~/shots --labels ~/shots/labels.json --recorded /tmp/rec --out /tmp/results.json
```

`--photos`, `--labels`, `--recorded` and `--out` point the run at other folders, for trying photos you do not want in the repo. The app reads recordings from `eval/recorded/` unless `HALFTIME_RECORDED` names another folder.

The script reads `.env.local` if it exists. It prints, per photo, `predicted/label` for each item, then:

- **every item exact**: photos where all five counts were right
- **item counts exact**: the share of individual item counts that were right
- **mean absolute error**: average units off per item per photo
- **PayPal floor**: how many undercounts the recount check would have caught. Each photo is treated as an opening count, assuming 80% of the stock sells and half of that is paid through PayPal (change with `--sell-through` and `--paypal-share`). An undercount is caught only when it is larger than the item's cash sales. Overcounts are not caught this way; they show up as cash that seems to be missing, which is why a second volunteer checks every count.

Keep the total number of live calls small when iterating; each photo is one model call.
