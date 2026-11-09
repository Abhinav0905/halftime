# Demo photos

Two photos of the same concession table let anyone try the photo count without a camera or a Gemini API key. When a file below exists, the count screen shows **Use the demo photo**. The photo is uploaded like any other, and the suggested count comes from its recording in `eval/recorded/`. With `GEMINI_API_KEY` set, the photo is counted live, and the recording is used only if the live call fails.

| File | Shown on | What it shows |
|---|---|---|
| `open.jpg` | Opening count | The stocked table before the stand opens |
| `close.jpg` | Closing count | The same table after the game |

The two photos here are staged demo images of an unbranded table: 8 water bottles, 7 bags of chips, 5 candy bars and 4 foil-wrapped hot dogs at the opening count, and 4, 4, 3 and 3 at the close. The recorded counts in `eval/recorded/` match those numbers. The sample menu also lists sports drinks; there are none on this table, so the buyer menu leaves them out for a game that opens with zero. To use your own table, replace both files and record again as described below.

## What to shoot

- Use items from the sample club's menu: water bottles, sports drinks, chip bags, candy bars and foil-wrapped hot dogs. Anything you leave out is simply not sold that night.
- **open.jpg**: the stocked table. Everything lies flat on one table, with a little space between items.
- **close.jpg**: the same table after the game, shot from the same spot. Fewer items, a few gaps, maybe something knocked over. Every item should have the same number or fewer than in `open.jpg`, so the demo close-out adds up.
- Hold the phone straight overhead so the whole table fits, with a small margin. Even light works best; avoid glare on the bottles.
- Turn brand labels away from the camera, or cover them, so the photos can be shown in public. Keep people, faces and school names out of the frame.
- Count each photo by hand, twice. You'll use those numbers to check the recording.

## Prepare the files

- JPEG, at most 1600 px on the long edge and under 2.5 MB, named exactly `open.jpg` and `close.jpg`.
- Remove the location when you export (iPhone Photos: Share → Options → Location off).
- Open each file in a browser to check it looks right side up.

The app uploads the file exactly as it is stored, so its SHA-256 matches the recording. Any change to a photo, even saving it again, changes that hash. Record again after every edit.

## Record the counts

```sh
npm run demo:record                  # both photos; needs GEMINI_API_KEY in .env.local
npm run demo:record -- --only close  # just one
```

This sends each photo to Gemini once and writes `eval/recorded/<sha256>.json`. It prints the counts. Check them against your hand count. If they are off, reshoot with more space between items or less glare, then run it again. The recording of the old photo is deleted.

Commit the photos and their recordings together:

```sh
git add public/demo/open.jpg public/demo/close.jpg eval/recorded/
```

To try it without a key, remove `GEMINI_API_KEY` from `.env.local` (or set `VISION_PROVIDER=replay`), restart the app, and use the demo photo on a new game's opening count.
