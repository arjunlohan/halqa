import { useQuery } from "@tanstack/react-query";
import ClickSpark from "@/reactbits/ClickSpark";
import PillNav from "@/reactbits/PillNav";
import { ConsoleShell } from "./console/Shell.js";
import { Demo } from "./Demo.js";
import { Landing } from "./Landing.js";
import { hrefFor, useRoute, type SiteRoute } from "./router.js";
import { useTRPC } from "./trpc.js";

const NAV: readonly { readonly route: SiteRoute; readonly label: string }[] = [
  { route: "home", label: "Halqa" },
  { route: "demo", label: "Live demo" },
  { route: "console", label: "Console" },
];

// The mark is a closed loop: "halqa" is Arabic for a ring or a link.
const Logo = (
  <svg viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="Halqa">
    <circle cx="12" cy="12" r="8.2" fill="none" stroke="#2dd4bf" strokeWidth="2.6" />
    <circle cx="12" cy="3.8" r="2.1" fill="#7cf5dd" />
  </svg>
);

/** The guided demo, with the clock and the navigator it acts as taken from the running system. */
function DemoPage() {
  const trpc = useTRPC();
  const board = useQuery(trpc.board.queryOptions(undefined, { refetchInterval: 1000 }));
  const navigator = board.data?.staff.navigators[0]?.ref ?? "";
  return (
    <div className="shell app">
      <div className="banner" role="note">
        <span>
          <strong>Synthetic data only.</strong> No real patient appears on any screen.
        </span>
        <span>Patient wording is not clinically approved.</span>
      </div>
      {board.isError ? (
        <main className="programme">
          <div className="alert" role="alert">
            <strong>The API is not answering.</strong>
            <span>
              Start it with <code>pnpm dev</code> from the repository root, then reload.
            </span>
          </div>
        </main>
      ) : board.data === undefined ? (
        <main className="programme">
          <p className="hint">Loading…</p>
        </main>
      ) : (
        <Demo now={board.data.now} navigator={navigator} />
      )}
    </div>
  );
}

export function App() {
  const route = useRoute();
  // The console is an application of its own: its navigation is its sidebar.
  if (route.page === "console") return <ConsoleShell path={route.path} />;

  return (
    <div className="legacy">
      <ClickSpark sparkColor="#2dd4bf" sparkCount={8} sparkRadius={18} sparkSize={9} duration={420}>
        <div className={`site-nav${route.page === "demo" ? " solid" : ""}`}>
          <PillNav
            logo={Logo}
            logoHref={hrefFor("home")}
            logoAlt="Halqa home"
            items={NAV.map((item) => ({ label: item.label, href: hrefFor(item.route) }))}
            activeHref={hrefFor(route.page)}
            theme="dark"
            surface="glass"
            size="md"
            highlightColor="#2dd4bf"
            highlightTextColor="#03211d"
            ariaLabel="Halqa"
          />
        </div>
        {route.page === "home" ? <Landing /> : <DemoPage />}
      </ClickSpark>
    </div>
  );
}
