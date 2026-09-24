import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/** Parser-owned options always disable app-authored raw HTML. */
export function MarkdownRenderer({
  children,
  components,
}: {
  readonly children: string;
  readonly components: Components;
}) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {children}
    </Markdown>
  );
}
