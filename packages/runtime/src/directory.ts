// Synthetic people and places. Every name here is invented for the prototype.
import type { Clinician, Navigator, Owner } from "@halqa/kernel";
import { zResourceRef } from "@halqa/fhir";

const practitioner = (id: string) => zResourceRef.parse(`Practitioner/${id}`);

export type StaffMember<A extends Owner> = { readonly actor: A; readonly name: string; readonly role: string };

export const NAVIGATORS: readonly StaffMember<Navigator>[] = [
  { actor: { kind: "navigator", practitioner: practitioner("nav-mariam") }, name: "Mariam A.", role: "Care navigator" },
  { actor: { kind: "navigator", practitioner: practitioner("nav-joseph") }, name: "Joseph K.", role: "Care navigator" },
  { actor: { kind: "navigator", practitioner: practitioner("nav-noura") }, name: "Noura R.", role: "Care navigator" },
];

export const CLINICIANS: readonly StaffMember<Clinician>[] = [
  { actor: { kind: "clinician", practitioner: practitioner("dr-layla"), licence: "SYN-GD-0001" }, name: "Dr Layla H.", role: "Screening clinician" },
  { actor: { kind: "clinician", practitioner: practitioner("dr-omar"), licence: "SYN-GD-0002" }, name: "Dr Omar S.", role: "Screening clinician" },
];

/** Who is told at escalation levels 1, 2 and 3, by role. */
export const ESCALATION_CONTACTS = {
  owner: "the case owner",
  "team-lead": "Hessa M., navigation team lead",
  "programme-lead": "Dr Yousef B., programme lead",
} as const;

export const staffName = (ref: string): string =>
  [...NAVIGATORS, ...CLINICIANS].find((s) => s.actor.practitioner === ref)?.name ?? ref;

export type Provider = {
  readonly key: "a" | "b";
  readonly name: { readonly en: string; readonly ar: string };
  /** Start times in minutes after local midnight. */
  readonly starts: readonly number[];
};

export const PROVIDERS: readonly Provider[] = [
  { key: "a", name: { en: "Saadiyat Endoscopy Unit", ar: "وحدة السعديات للمناظير" }, starts: [8 * 60 + 30, 13 * 60] },
  { key: "b", name: { en: "Corniche Day Surgery", ar: "مركز الكورنيش لجراحة اليوم الواحد" }, starts: [10 * 60, 15 * 60 + 30] },
];
