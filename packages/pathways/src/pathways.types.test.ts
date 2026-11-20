// Compile-time proof, checked by `pnpm typecheck`: a pathway that forgets a state's deadline does not compile.
import { crcFitPositive, type Pathway } from "./index.js";

export const broken = {
  ...crcFitPositive,
  // @ts-expect-error  Property '"awaiting-resolution"' is missing
  sla: { "awaiting-notification": 24, "awaiting-acknowledgement": 72, "awaiting-booking": 120, "awaiting-attendance": 744 },
} as const satisfies Pathway;
