import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

class MarkdownUnavailable extends Schema.TaggedError<MarkdownUnavailable>()(
  "MarkdownUnavailable",
  {},
) {}

/** Keep the parser out of the dashboard entry and reuse it once a document is opened. */
export const markdownRendererAtom = Atom.make(
  Effect.tryPromise({
    try: () => import("../implementation/dashboard/markdown-renderer.tsx"),
    catch: () => new MarkdownUnavailable({}),
  }),
).pipe(Atom.keepAlive);
