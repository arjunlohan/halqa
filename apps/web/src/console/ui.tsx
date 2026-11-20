// Small pieces the console pages share. Everything interactive here is a shadcn component.
import { cn } from "cn";
import { Check, ChevronRight, Copy } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Staff } from "../trpc.js";

/** Who is using the console. The sandbox has no sign-in, so the header lets you pick. */
export type Actor = { readonly ref: string; readonly name: string; readonly isClinician: boolean };
export const ActorContext = createContext<Actor>({ ref: "", name: "", isClinician: false });
export const useActor = (): Actor => useContext(ActorContext);

/** The people a case can belong to, or the console can act as, grouped by role. Goes inside a SelectContent. */
export function StaffOptions({ staff }: { readonly staff: Staff }) {
  const groups = [
    { label: "Care navigators", people: staff.navigators },
    { label: "Screening clinicians", people: staff.clinicians },
  ];
  return groups.map((group) => (
    <SelectGroup key={group.label}>
      <SelectLabel>{group.label}</SelectLabel>
      {group.people.map((person) => (
        <SelectItem key={person.ref} value={person.ref}>
          {person.name}
        </SelectItem>
      ))}
    </SelectGroup>
  ));
}

export function PageHeader({ title, description, actions }: { readonly title: string; readonly description?: ReactNode; readonly actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description !== undefined && <p className="mt-1 max-w-[72ch] text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A bordered block with a title. The console's one container shape. */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly bodyClassName?: string | undefined;
}) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      {(title !== undefined || action !== undefined) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description !== undefined && <p className="mt-0.5 text-[13px] text-pretty text-muted-foreground">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A definition list of label and value rows. */
export function Fields({ children, className }: { readonly children: ReactNode; readonly className?: string | undefined }) {
  return <dl className={cn("grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm", className)}>{children}</dl>;
}

export function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** A status word with its colour. The word always carries the meaning; the dot only repeats it. */
export function Status({ tone, children }: { readonly tone: "good" | "warn" | "crit" | "quiet" | "accent"; readonly children: ReactNode }) {
  const dot = { good: "bg-good", warn: "bg-warn", crit: "bg-crit", quiet: "bg-muted-foreground/60", accent: "bg-primary" }[tone];
  const text = { good: "text-foreground", warn: "text-warn", crit: "text-crit", quiet: "text-muted-foreground", accent: "text-foreground" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-2", text)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {children}
    </span>
  );
}

/** An identifier, shortened, with a button that copies the whole of it. */
export function CopyId({ value, head = 8 }: { readonly value: string; readonly head?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + 5 ? `${value.slice(0, head)}…${value.slice(-4)}` : value;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <span title={value}>{short}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label={`Copy ${value}`}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** A section that starts closed: a heading you open when you want the detail. */
export function Disclosure({ title, children, defaultOpen = false, className }: { readonly title: ReactNode; readonly children: ReactNode; readonly defaultOpen?: boolean; readonly className?: string | undefined }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("group/disclosure", className)}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 px-2 text-[13px] font-medium text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform duration-150 group-data-[state=open]/disclosure:rotate-90" />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 pb-1 pl-5 text-[13px] text-muted-foreground">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function Empty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children !== undefined && <p className="max-w-[52ch] text-[13px] text-pretty text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Arabic text set in the Arabic face, right to left. */
export function Said({ lang, children, className }: { readonly lang: string; readonly children: ReactNode; readonly className?: string | undefined }) {
  return (
    <span lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} className={cn("block", lang === "ar" && "text-[15px]", className)}>
      {children}
    </span>
  );
}
