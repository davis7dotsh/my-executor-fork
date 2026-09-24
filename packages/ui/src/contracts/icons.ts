import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Effect, Option, Schema } from "effect";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { Query } from "./dashboard.ts";

class IconDomainsUnavailable extends Schema.TaggedError<IconDomainsUnavailable>()(
  "IconDomainsUnavailable",
  {},
) {}

const domainParserAtom = Atom.make(
  Effect.tryPromise({
    try: () => import("tldts"),
    catch: () => new IconDomainsUnavailable({}),
  }),
).pipe(Atom.keepAlive);

/** Load the suffix list on demand; no unparsed host or URL is ever sent to the logo proxy. */
export const faviconUrlAtom = Atom.family(
  ({ url, size }: { readonly url: string | null | undefined; readonly size: number }) =>
    Atom.make((get) => {
      if (!url) return null;
      const parser = AsyncResult.value(get(domainParserAtom));
      if (Option.isNone(parser)) return null;
      const domain =
        parser.value.getDomain(url) ??
        (URL.canParse(url) ? parser.value.getDomain(new URL(url).hostname) : null);
      return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
    }),
);

/** Exact catalog names can supply missing display metadata; ambiguous brands never guess a domain. */
export const catalogIconDomainsAtom = <E>(catalogAtom: Query<readonly CatalogEntry[], E>) =>
  Atom.make((get) => {
    const domains = new Map<string, string | null>();
    const catalog = AsyncResult.value(get(catalogAtom));
    if (Option.isNone(catalog)) return domains;
    const parser = AsyncResult.value(get(domainParserAtom));
    if (Option.isNone(parser)) return domains;
    for (const entry of catalog.value) {
      const name = entry.name.trim().toLowerCase();
      const domain = parser.value.getDomain(entry.domain);
      if (domain === null) continue;
      domains.set(name, domains.has(name) && domains.get(name) !== domain ? null : domain);
    }
    return domains;
  });
