// The closed catalogue: everything the system can say to a patient, per act and language.
// The model never writes patient-facing text. It picks an act; this file supplies the words.
//
// STATUS: NOT CLINICALLY APPROVED. Wording was written by the build team for a prototype on
// synthetic data. No clinician and no native-speaker linguist has reviewed it. The Arabic uses
// masculine address forms throughout; a production catalogue needs gendered variants.
import type { ActId } from "@halqa/kernel";

export type Lang = "ar" | "en";
export type Bilingual = Readonly<Record<Lang, string>>;

export type FaqId = "is-this-cancer" | "what-is-colonoscopy" | "who-are-you";
export const FAQ_IDS: readonly FaqId[] = ["is-this-cancer", "what-is-colonoscopy", "who-are-you"];

/** One appointment option as the patient hears it. `at` is epoch milliseconds. */
export type SlotOption = { readonly at: number; readonly provider: Bilingual };

type None = Readonly<Record<never, never>>;

/** The slot values each act takes. Together with the act id and language they are the exact record of what was said. */
export type ActParams = {
  readonly greet: None;
  readonly "verify-identity": None;
  readonly "deliver-result": None;
  readonly "teach-back": None;
  readonly "repeat-result": None;
  readonly "answer-approved-faq": { readonly faq: FaqId };
  readonly "offer-slots": { readonly options: readonly SlotOption[] };
  readonly "confirm-slot": { readonly option: SlotOption };
  readonly "send-prep-instructions": None;
  readonly remind: { readonly option: SlotOption };
  readonly reschedule: None;
  readonly "hand-off-to-human": { readonly style: "transfer" | "call-back" };
  readonly "emergency-guidance": None;
};

type Wording<P> = { readonly [L in Lang]: (params: P) => string };

const LOCALE: Readonly<Record<Lang, string>> = { ar: "ar-AE", en: "en-GB" };

const spokenWhen = (lang: Lang): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(LOCALE[lang], {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    numberingSystem: "latn",
    timeZone: "Asia/Dubai",
  });
const WHEN: Readonly<Record<Lang, Intl.DateTimeFormat>> = { ar: spokenWhen("ar"), en: spokenWhen("en") };

/** A date and time as spoken, in Gulf Standard Time. */
export const formatWhen = (at: number, lang: Lang): string => WHEN[lang].format(new Date(at));

const ORDINAL: Readonly<Record<Lang, readonly string[]>> = {
  en: ["Option one", "Option two", "Option three"],
  ar: ["الخيار الأول", "الخيار الثاني", "الخيار الثالث"],
};

const listOptions = (options: readonly SlotOption[], lang: Lang): string =>
  options
    .slice(0, 3)
    .map((o, i) => {
      const label = ORDINAL[lang][i] ?? "";
      return lang === "ar"
        ? `${label}: ${formatWhen(o.at, "ar")} في ${o.provider.ar}.`
        : `${label}: ${formatWhen(o.at, "en")} at ${o.provider.en}.`;
    })
    .join(" ");

const FAQ: Readonly<Record<FaqId, Bilingual>> = {
  "is-this-cancer": {
    en: "I can't tell you that, and this test can't either. A screening result is not a diagnosis. The colonoscopy is how doctors find the cause. If you would like to talk it through with a nurse, say “nurse” and I will connect you.",
    ar: "لا أستطيع أن أخبرك بذلك، وهذا الفحص لا يستطيع أيضاً. نتيجة الفحص المبكر ليست تشخيصاً، وتنظير القولون هو الطريقة التي يعرف بها الأطباء السبب. إذا أردت التحدث مع ممرضة، قل «ممرضة» وسأحوّلك.",
  },
  "what-is-colonoscopy": {
    en: "A colonoscopy is a test where a doctor looks at the inside of the bowel with a small camera. Your clinic will send you instructions on how to prepare.",
    ar: "تنظير القولون فحص ينظر فيه الطبيب إلى داخل الأمعاء بكاميرا صغيرة. سترسل لك العيادة تعليمات التحضير.",
  },
  "who-are-you": {
    en: "I am an automated assistant for the screening programme. I can share your result, check that it is clear, and book your next appointment. I can't give medical advice.",
    ar: "أنا مساعد آلي لبرنامج الفحص المبكر. أستطيع إبلاغك بنتيجتك والتأكد من وضوحها وحجز موعدك التالي. لا أستطيع تقديم نصيحة طبية.",
  },
};

// The annotation is the coverage proof: remove an act or a language and this file does not compile.
const ACTS: { readonly [A in ActId]: Wording<ActParams[A]> } = {
  greet: {
    en: () =>
      "Hello. This is an automated assistant calling from the Abu Dhabi screening programme on behalf of your clinic. I am not a person. You can ask for a nurse at any time.",
    ar: () =>
      "مرحباً. معك المساعد الآلي لبرنامج الفحص المبكر في أبوظبي، أتصل بالنيابة عن عيادتك. أنا لست شخصاً، ويمكنك طلب التحدث مع ممرضة في أي وقت.",
  },
  "verify-identity": {
    en: () =>
      "Before I share anything, I need to check who I am speaking to. Please tell me your year of birth and the last four digits of your Emirates ID.",
    ar: () =>
      "قبل أن أشارك أي معلومات، أحتاج إلى التأكد من هويتك. من فضلك اذكر سنة ميلادك وآخر أربعة أرقام من بطاقة الهوية الإماراتية.",
  },
  "deliver-result": {
    en: () =>
      "Thank you. Your recent stool screening test showed traces of blood. This is a screening result, not a diagnosis. Most people with this result do not have cancer, but the next step is important: a camera test of the bowel, called a colonoscopy, to find the cause.",
    ar: () =>
      "شكراً لك. أظهر فحص البراز الذي أجريته مؤخراً وجود آثار دم. هذه نتيجة فحص مبكر وليست تشخيصاً. معظم من تظهر لديهم هذه النتيجة غير مصابين بالسرطان، لكن الخطوة التالية مهمة: فحص للقولون بالمنظار لمعرفة السبب.",
  },
  "teach-back": {
    en: () => "To make sure I explained that clearly, could you tell me in your own words what the next step is?",
    ar: () => "لأتأكد من أنني شرحت ذلك بوضوح، هل يمكنك أن تخبرني بكلماتك ما هي الخطوة التالية؟",
  },
  "repeat-result": {
    en: () =>
      "Let me say that again more simply. The test found a small amount of blood in your stool sample. It does not tell us why. The next step is a colonoscopy, a camera test of the bowel. What will you do next?",
    ar: () =>
      "دعني أعيد ذلك بشكل أبسط. وجد الفحص كمية صغيرة من الدم في عينة البراز، ولا يخبرنا الفحص عن السبب. الخطوة التالية هي تنظير القولون، أي فحص الأمعاء بكاميرا صغيرة. ما الذي ستفعله بعد ذلك؟",
  },
  "answer-approved-faq": {
    en: ({ faq }) => FAQ[faq].en,
    ar: ({ faq }) => FAQ[faq].ar,
  },
  "offer-slots": {
    en: ({ options }) =>
      `I can book your colonoscopy now. ${listOptions(options, "en")} Which one would you like? You can also say “none of these”.`,
    ar: ({ options }) =>
      `أستطيع حجز موعد تنظير القولون الآن. ${listOptions(options, "ar")} أي خيار تفضّل؟ ويمكنك أن تقول «لا يناسبني».`,
  },
  "confirm-slot": {
    en: ({ option }) =>
      `Your colonoscopy is booked for ${formatWhen(option.at, "en")} at ${option.provider.en}. You will get a text message with the details. Thank you, and goodbye.`,
    ar: ({ option }) =>
      `تم حجز موعد تنظير القولون يوم ${formatWhen(option.at, "ar")} في ${option.provider.ar}. ستصلك رسالة نصية بالتفاصيل. شكراً لك، مع السلامة.`,
  },
  "send-prep-instructions": {
    en: () => "I have sent the preparation instructions to your phone by text message.",
    ar: () => "أرسلت تعليمات التحضير إلى هاتفك برسالة نصية.",
  },
  remind: {
    en: ({ option }) => `This is a reminder of your colonoscopy on ${formatWhen(option.at, "en")} at ${option.provider.en}.`,
    ar: ({ option }) => `هذا تذكير بموعد تنظير القولون يوم ${formatWhen(option.at, "ar")} في ${option.provider.ar}.`,
  },
  reschedule: {
    en: () => "I understand you need a different time. A nurse navigator will call you to arrange it.",
    ar: () => "فهمت أنك تحتاج إلى موعد آخر. ستتصل بك ممرضة منسّقة لترتيب ذلك.",
  },
  "hand-off-to-human": {
    en: ({ style }) =>
      style === "transfer"
        ? "I am connecting you with a nurse navigator now. If we get cut off, they will call you back today."
        : "To protect your privacy I can't continue this call. A nurse navigator will call you back.",
    ar: ({ style }) =>
      style === "transfer"
        ? "سأحوّلك الآن إلى ممرضة منسّقة. إذا انقطع الاتصال فستعاود الاتصال بك اليوم."
        : "حفاظاً على خصوصيتك لا أستطيع متابعة هذه المكالمة. ستعاود ممرضة منسّقة الاتصال بك.",
  },
  "emergency-guidance": {
    en: () =>
      "What you describe may need urgent care. If you have heavy bleeding, severe pain, or feel faint, call 998 for an ambulance now or go to the nearest emergency department. I am alerting a nurse navigator, who will call you straight away.",
    ar: () =>
      "ما تصفه قد يحتاج إلى رعاية عاجلة. إذا كان لديك نزيف شديد أو ألم شديد أو شعرت بالإغماء، اتصل بالإسعاف على الرقم 998 الآن أو توجّه إلى أقرب قسم طوارئ. سأبلّغ ممرضة منسّقة لتتصل بك فوراً.",
  },
};

export const CATALOGUE = {
  id: "crc-fit-positive",
  version: 1,
  status: "not clinically approved",
} as const;

/** What the system said, exactly: enough to reproduce the words without storing audio. */
export type Utterance<A extends ActId = ActId> = {
  readonly act: A;
  readonly lang: Lang;
  readonly text: string;
  readonly params: ActParams[A];
  readonly catalogueId: string;
  readonly catalogueVersion: number;
};

/** The only way patient-facing text is produced. */
export function render<A extends ActId>(act: A, lang: Lang, params: ActParams[A]): Utterance<A> {
  const text = ACTS[act][lang](params);
  return { act, lang, text, params, catalogueId: CATALOGUE.id, catalogueVersion: CATALOGUE.version };
}

/** Every string the catalogue can produce for fixed-wording acts, used by tests to show speech is a closed set. */
export const fixedWordings = (lang: Lang): readonly string[] => [
  render("greet", lang, {}).text,
  render("verify-identity", lang, {}).text,
  render("deliver-result", lang, {}).text,
  render("teach-back", lang, {}).text,
  render("repeat-result", lang, {}).text,
  ...FAQ_IDS.map((faq) => render("answer-approved-faq", lang, { faq }).text),
  render("send-prep-instructions", lang, {}).text,
  render("reschedule", lang, {}).text,
  render("hand-off-to-human", lang, { style: "transfer" }).text,
  render("hand-off-to-human", lang, { style: "call-back" }).text,
  render("emergency-guidance", lang, {}).text,
];

// ───────────────────────── Replaying the utterance log ─────────────────────────
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

const asOption = (value: unknown): SlotOption | null => {
  if (!isRecord(value) || typeof value["at"] !== "number" || !isRecord(value["provider"])) return null;
  const { ar, en } = value["provider"];
  return typeof ar === "string" && typeof en === "string" ? { at: value["at"], provider: { ar, en } } : null;
};

/**
 * The words behind one row of the utterance log, rebuilt from act id, language and slot values.
 * This is the claim "the record of system speech is exact" made executable: no stored text, no audio.
 */
export function renderFromLog(act: string, lang: string, params: unknown): string | null {
  if ((lang !== "ar" && lang !== "en") || !isRecord(params)) return null;
  switch (act) {
    case "greet":
    case "verify-identity":
    case "deliver-result":
    case "teach-back":
    case "repeat-result":
    case "send-prep-instructions":
    case "reschedule":
    case "emergency-guidance":
      return render(act, lang, {}).text;
    case "answer-approved-faq": {
      const faq = FAQ_IDS.find((id) => id === params["faq"]);
      return faq === undefined ? null : render(act, lang, { faq }).text;
    }
    case "offer-slots": {
      const raw = params["options"];
      const options = Array.isArray(raw) ? raw.map(asOption) : [];
      const valid = options.filter((option): option is SlotOption => option !== null);
      return valid.length === 0 || valid.length !== options.length ? null : render(act, lang, { options: valid }).text;
    }
    case "confirm-slot":
    case "remind": {
      const option = asOption(params["option"]);
      return option === null ? null : render(act, lang, { option }).text;
    }
    case "hand-off-to-human": {
      const style = params["style"];
      return style === "transfer" || style === "call-back" ? render(act, lang, { style }).text : null;
    }
    default:
      return null;
  }
}
