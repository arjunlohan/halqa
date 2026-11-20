// Prints the chart text of each synthetic patient exactly as the record review sends it to the
// model, with the hash and record list a stored review must carry. Used to (re)generate
// packages/review/src/stored-reviews.json.
//
//   pnpm --filter @halqa/api exec tsx src/tools/review-bundles.ts            the bundles, as JSON
//   pnpm --filter @halqa/api exec tsx src/tools/review-bundles.ts --prompt   the system prompt
import { REVIEW_SYSTEM, reviewUserMessage } from "@halqa/review";
import { syntheticBundles } from "./bundles.js";

if (process.argv.includes("--prompt")) {
  console.log(REVIEW_SYSTEM);
} else {
  const out = syntheticBundles().map(({ patient, bundle }) => ({ patient, bundleHash: bundle.hash, covers: bundle.lines.map((line) => line.ref), user: reviewUserMessage(bundle.text) }));
  console.log(JSON.stringify(out, null, 2));
}
