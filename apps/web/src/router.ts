import { useEffect, useState } from "react";

/** The site has three places: the landing page, the guided demo, and the console with its own pages. */
export type Route = { readonly page: "home" | "demo" | "console"; readonly path: readonly string[] };
export type SiteRoute = "home" | "demo" | "console" | "programme";

export const hrefFor = (route: SiteRoute): string => (route === "home" ? "#/" : route === "programme" ? "#/console/programme" : `#/${route}`);

/** A link inside the console, for example `consoleHref("case", id)`. */
export const consoleHref = (...segments: readonly string[]): string => (segments.length === 0 ? "#/console" : `#/console/${segments.join("/")}`);

const parse = (hash: string): Route => {
  const [first, ...rest] = hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "");
  if (first === "demo") return { page: "demo", path: [] };
  if (first === "console") return { page: "console", path: rest };
  // The programme view used to be a page of its own; old links land on it inside the console.
  if (first === "programme") return { page: "console", path: ["programme"] };
  return { page: "home", path: [] };
};

export const navigate = (href: string): void => {
  window.location.hash = href.slice(1);
};

/** Hash routes: no server configuration, and a deep link survives a reload. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
