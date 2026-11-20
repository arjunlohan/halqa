// Deterministic listening rules, in English and Arabic. Three of them run on every patient
// utterance whatever model is in use: the red-flag check, the identity check and language detection.
// The rest (intents, teach-back grading) are the rules brain's ear.
import type { FaqId, Lang } from "@halqa/catalogue";

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export const latinDigits = (text: string): string =>
  text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const index = ARABIC_INDIC.indexOf(digit);
    return String(index >= 0 ? index : EASTERN_ARABIC_INDIC.indexOf(digit));
  });

/** Fold spelling variants so that one phrase list matches however the text was typed or transcribed. */
export const foldArabic = (text: string): string =>
  text
    .replace(/[ً-ْـ]/g, "") // short-vowel marks and tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");

/** The language of an utterance by script. Digits and punctuation alone keep the current language. */
export const detectLang = (text: string, current: Lang): Lang => {
  const arabic = text.match(/[ء-ي]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (arabic === 0 && latin === 0) return current;
  return arabic >= latin ? "ar" : "en";
};

type Lexicon = { readonly en: RegExp; readonly ar: readonly string[] };

const lexicon = (en: RegExp, ar: readonly string[]): Lexicon => ({ en, ar: ar.map(foldArabic) });

const hears = (lex: Lexicon, text: string): boolean => {
  if (lex.en.test(text)) return true;
  const folded = foldArabic(text);
  return lex.ar.some((phrase) => folded.includes(phrase));
};

// ───────────────────────── Red flags ─────────────────────────
// Tuned for recall: a false alarm costs a nurse a phone call, a miss can cost far more.
const RED_FLAG = lexicon(
  /\b(heavy bleeding|bleeding (a lot|heavily|badly|so much)|(i am|i'm|im|i have been|i've been|started|still) bleeding|(lots?|a lot) of blood|blood (everywhere|pouring|won'?t stop)|faint(ed|ing)?|dizz(y|iness)|light-?headed|pass(ed|ing) out|black(ed|ing)? out|collaps(e|ed|ing)|chest pain|can'?t breathe|cannot breathe|short(ness)? of breath|(severe|terrible|unbearable|extreme|worst) (pain|cramps?)|vomiting blood|throwing up blood|black (stools?|poo))\b/i,
  [
    "نزيف شديد",
    "نزيف حاد",
    "نزيف كثير",
    "نزيف قوي",
    "أنزف",
    "دم كثير",
    "دوخة",
    "دايخ",
    "دوار",
    "إغماء",
    "أغمي",
    "سيغمى",
    "ألم شديد",
    "وجع شديد",
    "ألم في الصدر",
    "ألم بالصدر",
    "لا أستطيع التنفس",
    "ضيق في التنفس",
    "ضيق تنفس",
    "أتقيأ دم",
    "قيء دم",
    "براز أسود",
  ],
);

export const isRedFlag = (text: string): boolean => hears(RED_FLAG, text);

/** The red-flag rule as it can be shown to staff: the English pattern and the Arabic phrases it listens for. */
export const RED_FLAG_RULE = { en: RED_FLAG.en.source, ar: RED_FLAG.ar } as const;

// ───────────────────────── Identity ─────────────────────────
export type IdentityCheck = "match" | "mismatch" | "no-identifiers";

/** Two identifiers, both required: the year of birth and the last four digits of the ID, as separate digit runs. */
export function checkIdentity(text: string, expected: { readonly birthYear: string; readonly idLast4: string }): IdentityCheck {
  const digits = latinDigits(text).replace(/\D/g, "");
  if (digits.length < 4) return "no-identifiers";
  const year = digits.indexOf(expected.birthYear);
  if (year < 0) return "mismatch";
  const rest = digits.slice(0, year) + " " + digits.slice(year + expected.birthYear.length);
  return rest.includes(expected.idLast4) ? "match" : "mismatch";
}

// ───────────────────────── Intents ─────────────────────────
export type Intent = "ask-human" | "none-suitable" | "ask-diagnosis" | "ask-colonoscopy" | "ask-who" | "other";

const ASK_HUMAN = lexicon(
  /^\s*(a )?(nurse|human|person|operator)[.!?\s]*$|\b(talk|speak|connect|transfer|put|get|want|need|give|call)\b.{0,40}\b(nurse|human|person|doctor|someone|somebody|operator|staff)\b|\breal person\b/i,
  [
    "أريد ممرض",
    "أريد أن أتحدث",
    "أريد أن أتكلم",
    "أريد التحدث",
    "أبغى أكلم",
    "أبي أكلم",
    "حولني",
    "حوّلني",
    "أكلم ممرض",
    "أكلم شخص",
    "أتكلم مع",
    "أتحدث مع",
    "التحدث مع",
    "ممرضة من فضلك",
    "شخص حقيقي",
  ],
);
const NONE_SUITABLE = lexicon(
  /\bnone\b|\bneither\b|\b(other|different|another|more) (times?|days?|options?|dates?|slots?)\b|\b(can'?t|cannot|won'?t be able to) (make|do|come)\b|\bnot (good|suitable|possible)\b|\bdo(es)?n'?t (work|suit)\b/i,
  ["لا يناسب", "غير مناسب", "موعد آخر", "مواعيد أخرى", "خيارات أخرى", "ولا واحد", "وقت آخر", "يوم آخر", "لا أستطيع الحضور"],
);
const ASK_DIAGNOSIS = lexicon(
  /\b(cancer|tumou?rs?|malignant|am i (sick|ill|dying|going to die|ok|okay)|is (it|this) (serious|bad|dangerous)|what does (it|this|that) mean|should i (be )?worr(y|ied))\b/i,
  ["سرطان", "ورم", "خبيث", "هل أنا مريض", "هل سأموت", "هل هذا خطير", "هل الأمر خطير", "ماذا يعني", "ما معنى", "هل أقلق"],
);
const ASK_COLONOSCOPY = lexicon(
  /\bwhat('?s| is| are)? (a |an |the )?(colonoscop\w*|camera test|bowel test)\b|\bhow (does|do) (it|the test|they) (work|do it)\b|\bwhat happens (in|during)\b/i,
  ["ما هو التنظير", "ما هو تنظير", "ما هو المنظار", "ما هذا الفحص", "كيف يتم", "ماذا يحدث في"],
);
const ASK_WHO = lexicon(
  /\bwho (are you|is this|is calling|am i (talking|speaking) to)\b|\bare you (a |an )?(robot|real|human|ai|machine|person)\b/i,
  ["من أنت", "من معي", "مين معي", "من المتصل", "هل أنت روبوت", "هل أنت إنسان", "هل أنت آلي"],
);

export function classify(text: string): Intent {
  if (hears(ASK_HUMAN, text)) return "ask-human";
  if (hears(NONE_SUITABLE, text)) return "none-suitable";
  if (hears(ASK_DIAGNOSIS, text)) return "ask-diagnosis";
  if (hears(ASK_COLONOSCOPY, text)) return "ask-colonoscopy";
  if (hears(ASK_WHO, text)) return "ask-who";
  return "other";
}

export const wantsOtherSlots = (text: string): boolean => hears(NONE_SUITABLE, text);
export const asksForHuman = (text: string): boolean => hears(ASK_HUMAN, text);

export const faqFor = (intent: Intent): FaqId | null =>
  intent === "ask-diagnosis" ? "is-this-cancer" : intent === "ask-colonoscopy" ? "what-is-colonoscopy" : intent === "ask-who" ? "who-are-you" : null;

// ───────────────────────── Slot choice ─────────────────────────
// A bare "one" is not a choice ("the one on Monday"). An option is named by an ordinal, by a
// labelled number ("option 2"), or by a number that is the whole reply.
type Choice = { readonly n: 1 | 2 | 3; readonly en: RegExp; readonly ar: RegExp };
const CHOICES: readonly Choice[] = [
  {
    n: 1,
    en: /\b(first|1st)\b|\b(option|number|choice|slot)\s*(one|1)\b|^\W*(one|1)(\W+please)?\W*$/i,
    ar: /الاول|(رقم|خيار)\s*(واحد|1)|^\s*(واحد|1)\s*$/,
  },
  {
    n: 2,
    en: /\b(second|2nd)\b|\b(option|number|choice|slot)\s*(two|2)\b|^\W*(two|2)(\W+please)?\W*$/i,
    ar: /الثاني|(رقم|خيار)\s*(اثنين|اثنان|2)|^\s*(اثنين|اثنان|2)\s*$/,
  },
  {
    n: 3,
    en: /\b(third|3rd)\b|\b(option|number|choice|slot)\s*(three|3)\b|^\W*(three|3)(\W+please)?\W*$/i,
    ar: /الثالث|(رقم|خيار)\s*(ثلاثه|3)|^\s*(ثلاثه|3)\s*$/,
  },
];

/** Which of up to three spoken options the patient picked, or null when none or more than one is named. */
export function chosenOption(text: string): 1 | 2 | 3 | null {
  const latin = latinDigits(text);
  const folded = foldArabic(latin);
  const named = CHOICES.filter((choice) => choice.en.test(latin) || choice.ar.test(folded));
  const [only] = named;
  return named.length === 1 && only !== undefined ? only.n : null;
}

// ───────────────────────── Teach-back ─────────────────────────
const NAMES_NEXT_STEP = lexicon(/\b(colonoscop\w*|camera|scope|endoscop\w*|bowel (test|exam\w*|check))\b/i, [
  "تنظير",
  "منظار",
  "كاميرا",
  "فحص القولون",
  "فحص الأمعاء",
]);

/** Did the patient say, in any words, that the next step is the colonoscopy? */
export const namesNextStep = (text: string): boolean => hears(NAMES_NEXT_STEP, text);

/** Remove digit runs before text leaves the region: IDs, birth years and phone numbers are all digits. */
export const scrubIdentifiers = (raw: string): string => latinDigits(raw).replace(/\d[\d\s-]*\d|\d/g, "[number]");

/** What a patient's reply looks like in the stored call record: runs of four or more digits are removed. */
export const redactForRecord = (raw: string): string => latinDigits(raw).replace(/\d(?:[\s-]?\d){3,}/g, "[digits removed]");
