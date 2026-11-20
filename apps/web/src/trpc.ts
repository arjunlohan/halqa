import type { AppRouter } from "@halqa/api";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

type Outputs = inferRouterOutputs<AppRouter>;
export type Board = Outputs["board"];
export type CaseSummary = Board["cases"][number];
export type Staff = Board["staff"];
export type CaseDetail = Outputs["case"];
export type ChartRecord = CaseDetail["chart"][number];
export type ChartReview = NonNullable<CaseDetail["review"]>;
export type CallRow = Outputs["calls"]["calls"][number];
export type CallDetail = Outputs["callRecord"];
export type Turn = CallDetail["turnList"][number];
export type AgentTurn = Extract<Turn, { speaker: "agent" }>;
export type Config = Outputs["config"];
export type Programme = Outputs["programme"];
export type Arm = Programme["simulation"]["arms"][number];
export type IngestOutcome = Outputs["postFit"];
