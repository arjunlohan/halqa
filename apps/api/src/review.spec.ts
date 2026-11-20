import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zPatientRef } from "@halqa/fhir";
import { chartBundle, groundReview, type ReviewDraft } from "@halqa/review";
import { CLINICIANS, fitObservation, SYNTHETIC_PATIENT_IDS } from "@halqa/runtime";
import { describe, expect, it } from "vitest";
import { HalqaHost } from "./halqa.js";
import { ReviewService } from "./review.js";

const patient = (id: string) => zPatientRef.parse(`Patient/${id}`);
const freshRuntime = () => new HalqaHost(":memory:").current.runtime;
const cacheDir = () => mkdtempSync(join(tmpdir(), "halqa-review-"));

const draft = (overrides: Partial<ReviewDraft> = {}): ReviewDraft => ({
  summary: { text: "Aspirin is an active medicine.", cites: ["R6"] },
  relevant: [{ text: "Aspirin 81 mg is listed as active.", cites: ["R6"] }],
  toCheck: [],
  notFound: ["allergies"],
  ...overrides,
});

describe("the chart sent to the model", () => {
  it("carries no name and no identifier", () => {
    const runtime = freshRuntime();
    for (const id of SYNTHETIC_PATIENT_IDS) {
      const ref = patient(id);
      const resource = runtime.patient(ref);
      const bundle = chartBundle({ birthYear: resource?.birthDate?.slice(0, 4) ?? null, sex: resource?.gender ?? null, language: "ar" }, runtime.chart(ref));
      expect(bundle.lines.length).toBeGreaterThan(0);
      expect(bundle.text).not.toContain(resource?.name[0]?.text ?? "no-name");
      expect(bundle.text).not.toContain(id);
      for (const identifier of resource?.identifier ?? []) expect(bundle.text).not.toContain(identifier.value);
    }
  });
});

describe("grounding", () => {
  const runtime = freshRuntime();
  const bundle = chartBundle({ birthYear: "1968", sex: "male", language: "ar" }, runtime.chart(patient("syn-ahmed")));

  it("keeps a statement that cites a record in the chart", () => {
    const grounded = groundReview(draft(), bundle);
    expect(grounded.ok && grounded.review.relevant).toHaveLength(1);
    expect(grounded.ok && grounded.review.dropped).toBe(0);
  });

  it("drops a statement that cites nothing, or a record that is not in the chart", () => {
    const grounded = groundReview(
      draft({
        relevant: [
          { text: "The patient has a pacemaker.", cites: [] },
          { text: "Warfarin is an active medicine.", cites: ["R99"] },
          { text: "Aspirin 81 mg is listed as active.", cites: ["r6", "R99"] },
        ],
      }),
      bundle,
    );
    if (!grounded.ok) throw new Error("expected a review");
    expect(grounded.review.relevant).toEqual([{ text: "Aspirin 81 mg is listed as active.", cites: ["R6"] }]);
    expect(grounded.review.dropped).toBe(2);
  });

  it("refuses a review whose summary rests on no record", () => {
    expect(groundReview(draft({ summary: { text: "A healthy patient.", cites: ["R42"] } }), bundle)).toEqual({ ok: false, error: "summary-cites-no-record" });
  });

  it("sets the flag from the points that survived, never from the model", () => {
    const flagged = groundReview(draft({ toCheck: [{ text: "Aspirin affects bleeding.", cites: ["R6"] }] }), bundle);
    const unsupported = groundReview(draft({ toCheck: [{ text: "Warfarin affects bleeding.", cites: ["R77"] }] }), bundle);
    expect(flagged.ok && flagged.review.flag).toBe("clinician-should-review");
    expect(unsupported.ok && unsupported.review.flag).toBe("nothing-flagged");
  });
});

describe("the review a member of staff sees", () => {
  it("ships a stored review for every synthetic patient, written from exactly the chart on file", () => {
    const runtime = freshRuntime();
    const reviews = new ReviewService(cacheDir(), { request: null });
    for (const id of SYNTHETIC_PATIENT_IDS) {
      const review = reviews.current(runtime, patient(id));
      expect(review, id).not.toBeNull();
      expect(review?.source.kind).toBe("stored");
      expect(review?.dropped).toBe(0);
      expect(review?.notCovered).toEqual([]);
      expect(review?.lines).toHaveLength(runtime.chart(patient(id)).length);
    }
  });

  it("names the newer records a stored review never saw", () => {
    const runtime = freshRuntime();
    const reviews = new ReviewService(cacheDir(), { request: null });
    runtime.ingest(fitObservation({ id: "fit-new", patient: "Patient/syn-ahmed", issuedAt: runtime.now() }));
    expect(reviews.current(runtime, patient("syn-ahmed"))?.notCovered.map((record) => record.ref)).toEqual(["Observation/fit-new"]);
  });

  it("withdraws a stored review when a record it was written from changes", () => {
    const runtime = freshRuntime();
    const reviews = new ReviewService(cacheDir(), { request: null });
    const corrected = {
      resourceType: "Observation",
      id: "lab-hb-ahmed",
      meta: { versionId: "2" },
      status: "corrected",
      code: { coding: [{ system: "http://loinc.org", code: "718-7", display: "Haemoglobin" }] },
      subject: { reference: "Patient/syn-ahmed" },
      issued: "2026-10-28T06:30:00Z",
      valueQuantity: { value: 14.1, unit: "g/dL" },
      referenceRange: [{ text: "13.0 to 17.0" }],
    };
    expect(runtime.ingest(corrected).status).toBe("stored");
    expect(reviews.current(runtime, patient("syn-ahmed"))).toBeNull();
    expect(reviews.current(runtime, patient("syn-fatima"))).not.toBeNull();
  });

  it("keeps a live review on disk under the chart's hash, and refuses one that cites nothing", async () => {
    const runtime = freshRuntime();
    const dir = cacheDir();
    runtime.ingest(fitObservation({ id: "fit-live", patient: "Patient/syn-sara", issuedAt: runtime.now() }));
    const sent: string[] = [];
    const live = new ReviewService(dir, {
      request: (_system, user) => {
        sent.push(user);
        return Promise.resolve({ summary: { text: "A positive screening result is on file.", cites: ["R1"] }, relevant: [], toCheck: [], notFound: [] });
      },
    });
    expect(await live.run(runtime, patient("syn-sara"))).toEqual({ ok: true });
    expect(sent[0]).not.toContain("Sara");
    expect(live.current(runtime, patient("syn-sara"))?.source.kind).toBe("live");
    expect(new ReviewService(dir, { request: null }).current(runtime, patient("syn-sara"))?.summary.text).toBe("A positive screening result is on file.");
    expect(runtime.modelCalls().at(-1)).toMatchObject({ role: "record-review" });

    const ungrounded = new ReviewService(cacheDir(), { request: () => Promise.resolve({ summary: { text: "All is well.", cites: [] }, relevant: [], toCheck: [], notFound: [] }) });
    expect(await ungrounded.run(runtime, patient("syn-john"))).toMatchObject({ ok: false });
    expect(ungrounded.current(runtime, patient("syn-john"))?.source.kind).toBe("stored");
  });

  it("records who checked a review against the chart", () => {
    const host = new HalqaHost(":memory:");
    const runtime = host.current.runtime;
    const reviews = new ReviewService(cacheDir(), { request: null });
    const before = reviews.current(runtime, patient("syn-john"));
    if (before === null) throw new Error("expected a stored review");
    const clinician = CLINICIANS[0];
    if (clinician === undefined) throw new Error("the directory has no clinician");
    runtime.markReview(patient("syn-john"), before.hash, "checked", clinician.actor);
    expect(reviews.current(runtime, patient("syn-john"))?.marks).toMatchObject([{ kind: "checked", by: clinician.name }]);
  });
});
