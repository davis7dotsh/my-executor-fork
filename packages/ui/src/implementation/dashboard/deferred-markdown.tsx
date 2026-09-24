import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Components } from "react-markdown";
import { markdownRendererAtom } from "../../contracts/markdown.ts";

/** Source stays readable within the caller's document region while the renderer loads or fails. */
export function DeferredMarkdown({
  children,
  components,
}: {
  readonly children: string;
  readonly components: Components;
}) {
  const renderer = useAtomValue(markdownRendererAtom);
  return AsyncResult.isSuccess(renderer) ? (
    <renderer.value.MarkdownRenderer components={components}>
      {children}
    </renderer.value.MarkdownRenderer>
  ) : (
    <div className="whitespace-pre-wrap wrap-anywhere" aria-busy={renderer.waiting}>
      {children}
    </div>
  );
}
