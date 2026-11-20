// The console's frame: navigation on the left, a header that says where you are and who you are
// acting as, and one page filling the rest of the window. Pages scroll inside themselves.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AudioLines, ChartColumn, Database, FlaskConical, ListChecks, PhoneCall, Route as RouteIcon, ScrollText, ShieldCheck, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fmtDateTime, fmtSpan } from "../format.js";
import { Programme } from "../Programme.js";
import { consoleHref, hrefFor } from "../router.js";
import { useTRPC } from "../trpc.js";
import { CallsPage } from "./CallsPage.js";
import { CasePage } from "./CasePage.js";
import { Sandbox } from "./Sandbox.js";
import { Settings, SETTINGS_SECTIONS, type SettingsSection } from "./Settings.js";
import { ActorContext, Empty, StaffOptions, type Actor } from "./ui.js";
import { Worklist } from "./Worklist.js";

type NavItem = { readonly label: string; readonly href: string; readonly icon: ComponentType<{ className?: string }>; readonly match: (path: readonly string[]) => boolean };

const SETTINGS_ICON: Readonly<Record<SettingsSection, ComponentType<{ className?: string }>>> = {
  pathway: RouteIcon,
  script: ScrollText,
  guardrails: ShieldCheck,
  models: AudioLines,
  data: Database,
  team: Users,
};

const WORK: readonly NavItem[] = [
  { label: "Worklist", href: consoleHref(), icon: ListChecks, match: (path) => path.length === 0 || path[0] === "worklist" || path[0] === "case" },
  { label: "Calls", href: consoleHref("calls"), icon: PhoneCall, match: (path) => path[0] === "calls" },
  { label: "Programme", href: consoleHref("programme"), icon: ChartColumn, match: (path) => path[0] === "programme" },
];

const CONFIGURATION: readonly NavItem[] = SETTINGS_SECTIONS.map((section) => ({
  label: section.label,
  href: consoleHref("settings", section.id),
  icon: SETTINGS_ICON[section.id],
  match: (path) => path[0] === "settings" && path[1] === section.id,
}));

const SANDBOX: readonly NavItem[] = [{ label: "Simulator", href: consoleHref("sandbox"), icon: FlaskConical, match: (path) => path[0] === "sandbox" }];

// The mark is a closed loop: "halqa" is Arabic for a ring or a link.
const Logo = (
  <svg viewBox="0 0 24 24" className="size-5 shrink-0" role="img" aria-label="Halqa">
    <circle cx="12" cy="12" r="8.2" fill="none" stroke="#2dd4bf" strokeWidth="2.6" />
    <circle cx="12" cy="3.8" r="2.1" fill="#7cf5dd" />
  </svg>
);

function NavGroup({ label, items, path }: { readonly label: string; readonly items: readonly NavItem[]; readonly path: readonly string[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={item.match(path)} tooltip={item.label}>
                <a href={item.href}>
                  <item.icon />
                  <span>{item.label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const ACTOR_KEY = "halqa.actingAs";

/** A page whose whole body scrolls. */
function Scrolled({ children }: { readonly children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

export function ConsoleShell({ path }: { readonly path: readonly string[] }) {
  const trpc = useTRPC();
  const board = useQuery(trpc.board.queryOptions(undefined, { refetchInterval: 2000 }));
  const [chosen, setChosen] = useState<string | null>(() => window.localStorage.getItem(ACTOR_KEY));
  useEffect(() => {
    if (chosen !== null) window.localStorage.setItem(ACTOR_KEY, chosen);
  }, [chosen]);

  const staff = board.data?.staff;
  const actor = useMemo<Actor>(() => {
    const everyone = [...(staff?.navigators ?? []), ...(staff?.clinicians ?? [])];
    const found = everyone.find((person) => person.ref === chosen) ?? everyone[0];
    return { ref: found?.ref ?? "", name: found?.name ?? "", isClinician: staff?.clinicians.some((person) => person.ref === found?.ref) ?? false };
  }, [staff, chosen]);

  const [section, id] = path;
  const settingsSection = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  const caseName = section === "case" ? board.data?.cases.find((item) => item.id === id)?.patient.name : undefined;
  const crumb: { readonly parent: { label: string; href: string } | null; readonly here: string } =
    section === "case"
      ? { parent: { label: "Worklist", href: consoleHref() }, here: caseName ?? "Case" }
      : section === "calls"
        ? { parent: null, here: "Calls" }
        : section === "programme"
          ? { parent: null, here: "Programme" }
          : section === "settings"
            ? { parent: { label: "Configuration", href: consoleHref("settings", "pathway") }, here: settingsSection?.label ?? "Configuration" }
            : section === "sandbox"
              ? { parent: null, here: "Simulator" }
              : { parent: null, here: "Worklist" };

  const offset = board.data?.clockOffsetMs ?? 0;

  return (
    <ActorContext.Provider value={actor}>
      <TooltipProvider delayDuration={200}>
        <SidebarProvider className="h-svh min-h-0 font-sans text-sm text-foreground">
          <Sidebar collapsible="icon">
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="lg" asChild tooltip="Halqa">
                    <a href={consoleHref()}>
                      {Logo}
                      <span className="grid leading-tight">
                        <span className="font-semibold">Halqa</span>
                        <span className="text-xs text-muted-foreground">Al Bateen Family Clinic</span>
                      </span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <NavGroup label="Follow-up" items={WORK} path={path} />
              <NavGroup label="Configuration" items={CONFIGURATION} path={path} />
              <NavGroup label="Sandbox" items={SANDBOX} path={path} />
            </SidebarContent>
            <SidebarFooter>
              <p className="px-2 text-xs text-pretty text-muted-foreground group-data-[collapsible=icon]:hidden">Sandbox. Every patient and record here is synthetic.</p>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Back to the site">
                    <a href={hrefFor("home")}>
                      <ArrowLeft />
                      <span>Back to the site</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>

          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="h-5!" />
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="flex-nowrap">
                  {crumb.parent !== null && (
                    <>
                      <BreadcrumbItem className="hidden sm:block">
                        <BreadcrumbLink href={crumb.parent.href}>{crumb.parent.label}</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="hidden sm:block" />
                    </>
                  )}
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{crumb.here}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>

              <div className="ml-auto flex items-center gap-4">
                {board.data !== undefined && (
                  <div className="hidden text-right leading-tight md:block">
                    <div className="text-[13px] tabular-nums">{fmtDateTime(board.data.now)} GST</div>
                    {offset > 0 && (
                      <a href={consoleHref("sandbox")} className="text-xs text-warn underline-offset-2 hover:underline">
                        Sandbox clock is {fmtSpan(offset)} ahead
                      </a>
                    )}
                  </div>
                )}
                {staff !== undefined && (
                  <Select value={actor.ref} onValueChange={setChosen}>
                    <SelectTrigger size="sm" className="w-[11.5rem]" aria-label="Acting as">
                      <span className="text-muted-foreground">As</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <StaffOptions staff={staff} />
                    </SelectContent>
                  </Select>
                )}
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden">
              {board.isError ? (
                <Empty title="The API is not answering">Start it with pnpm dev from the repository root, then reload this page.</Empty>
              ) : board.data === undefined ? (
                <Empty title="Loading" />
              ) : section === "case" && id !== undefined ? (
                <CasePage key={id} caseId={id} staff={board.data.staff} />
              ) : section === "calls" ? (
                <Scrolled>
                  <CallsPage selected={id ?? null} />
                </Scrolled>
              ) : section === "programme" ? (
                <div className="legacy h-full overflow-y-auto">
                  <Programme />
                </div>
              ) : section === "settings" ? (
                <Scrolled>
                  <Settings section={settingsSection?.id ?? "pathway"} />
                </Scrolled>
              ) : section === "sandbox" ? (
                <Scrolled>
                  <Sandbox board={board.data} />
                </Scrolled>
              ) : (
                <Scrolled>
                  <Worklist board={board.data} />
                </Scrolled>
              )}
            </main>
          </SidebarInset>
          <Toaster position="bottom-right" />
        </SidebarProvider>
      </TooltipProvider>
    </ActorContext.Provider>
  );
}
