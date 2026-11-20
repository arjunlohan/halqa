// Each synthetic patient's chart exactly as the record review sends it to the model, built from
// the cohort file alone. Both review tools start from this.
import { chartRecord, subjectOf, type ChartRecord } from "@halqa/fhir";
import { bundleSubject, chartBundle, type Bundle } from "@halqa/review";
import { SYNTHETIC_CHARTS, SYNTHETIC_PATIENTS } from "@halqa/runtime";

export const syntheticBundles = (): readonly { readonly patient: string; readonly bundle: Bundle }[] =>
  SYNTHETIC_PATIENTS.map((patient) => {
    const ref = `Patient/${patient.id}`;
    const records = SYNTHETIC_CHARTS.filter((resource) => subjectOf(resource) === ref).flatMap((resource): ChartRecord[] => {
      const record = chartRecord(resource);
      return record === null ? [] : [record];
    });
    return { patient: ref, bundle: chartBundle(bundleSubject(patient), records) };
  });
