// Turns a file of model answers (patient ref -> review draft) into packages/review/src/stored-reviews.json.
// Each draft is parsed and grounded against the chart it was written from; a draft that fails is refused.
//
//   pnpm --filter @halqa/api exec tsx src/tools/store-reviews.ts <drafts.json> <model> <how it was produced>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { groundReview, zReviewDraft } from "@halqa/review";
import * as z from "zod";
import { syntheticBundles } from "./bundles.js";

const [draftsPath, model, via] = process.argv.slice(2);
if (draftsPath === undefined || model === undefined || via === undefined) throw new Error("usage: store-reviews <drafts.json> <model> <via>");

const drafts = z.record(z.string(), zReviewDraft).parse(JSON.parse(readFileSync(draftsPath, "utf8")));
const reviews: Record<string, { bundleHash: string; covers: string[]; draft: z.infer<typeof zReviewDraft> }> = {};

for (const { patient: ref, bundle } of syntheticBundles()) {
  const draft = drafts[ref];
  if (draft === undefined) throw new Error(`no draft for ${ref}`);
  const grounded = groundReview(draft, bundle);
  if (!grounded.ok) throw new Error(`${ref}: ${grounded.error}`);
  if (grounded.review.dropped > 0) throw new Error(`${ref}: ${grounded.review.dropped} statement(s) cite no record in the chart`);
  console.log(`${ref}: ${grounded.review.relevant.length} relevant, ${grounded.review.toCheck.length} to check, ${grounded.review.notFound.length} not found, flag ${grounded.review.flag}`);
  reviews[ref] = { bundleHash: bundle.hash, covers: bundle.lines.map((line) => line.ref), draft };
}

const out = fileURLToPath(new URL("../../../../packages/review/src/stored-reviews.json", import.meta.url));
writeFileSync(out, `${JSON.stringify({ model, generatedOn: new Date().toISOString().slice(0, 10), via, reviews }, null, 2)}\n`);
console.log(`wrote ${out}`);
