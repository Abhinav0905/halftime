// What the volunteer reads when there is no suggested count. No imports, so the
// count screen (a client component) can share these with the server.

export const MESSAGES = {
  failed: "The photo count did not work this time. Count by hand; the photo is still saved.",
  noRecording: "Photo counting is not set up on this copy of Halftime, and there is no recorded count for this photo. Count by hand; the photo is still saved.",
  manual: "Photo counting is turned off. Count by hand; the photo is still saved.",
  recordedFallback: "The live photo count did not answer, so this is the recorded count for this photo. Check it against the table.",
  busy: "Photo counting has been used many times in the last hour, so it is paused for now. Count by hand; the photo is still saved.",
} as const;
