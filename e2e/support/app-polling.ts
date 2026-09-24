import { Deferred, Effect } from "effect";
import { Browser } from "./browser.ts";

/** Control readiness responses and await each request at the browser's public HTTP boundary. */
export const controlledDomainReadiness = (app: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const arrivals = yield* Effect.all(Array.from({ length: 8 }, () => Deferred.make<void>()));
    let reads = 0;
    let ready = false;
    yield* browser.use("Hold domain readiness at its public HTTP boundary", (page) =>
      page.route(
        (url) => url.pathname.endsWith(`/apps/${app}/ui`),
        (route) => {
          const arrival = arrivals[reads++];
          return route
            .fulfill({
              status: 200,
              json: ready
                ? { status: "ready", url: "https://preview.example.test/" }
                : { status: "pending", url: null },
            })
            .then(() =>
              arrival === undefined
                ? undefined
                : Effect.runPromise(Deferred.succeed(arrival, undefined)),
            );
        },
      ),
    );
    return {
      requested: (index: number) =>
        Deferred.await(arrivals[index]!).pipe(Effect.timeout("5 seconds")),
      reads: () => reads,
      ready: () => {
        ready = true;
      },
    };
  });
