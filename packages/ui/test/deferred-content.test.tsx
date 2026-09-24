import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { renderToStaticMarkup } from "react-dom/server";
import { faviconUrlAtom, catalogIconDomainsAtom } from "../src/contracts/icons.ts";
import { markdownRendererAtom } from "../src/contracts/markdown.ts";
import { ToolMarkdown } from "../src/implementation/dashboard/markdown.tsx";
import { SkillContent } from "../src/implementation/dashboard/skill-content.tsx";

const registry = Effect.acquireRelease(
  Effect.sync(() => AtomRegistry.make()),
  (registry) => Effect.sync(() => registry.dispose()),
);

it.effect(
  "deferred icons only send registrable domains and retain ambiguous catalog fallbacks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const atoms = yield* registry;
        const icon = faviconUrlAtom({
          url: "https://private.customer.example.co.uk/path?token=x",
          size: 17,
        });
        expect(atoms.get(icon)).toBeNull();
        const parsed = yield* Effect.callback<string>((resume) => {
          const cancel = atoms.subscribe(icon, (value) => {
            if (value !== null) resume(Effect.succeed(value));
          });
          return Effect.sync(cancel);
        });
        expect(parsed).toBe("https://integrations.sh/logo/example.co.uk?sz=34");
        expect(
          atoms.get(faviconUrlAtom({ url: "http://localhost:1234/private", size: 17 })),
        ).toBeNull();
        expect(atoms.get(faviconUrlAtom({ url: "http://127.0.0.1/private", size: 17 }))).toBeNull();
        const catalog = Atom.make(
          AsyncResult.success([
            {
              id: "one",
              kind: "mcp" as const,
              name: "Same brand",
              description: "",
              domain: "first.com",
            },
            {
              id: "two",
              kind: "mcp" as const,
              name: "Same brand",
              description: "",
              domain: "second.co.uk",
            },
            {
              id: "three",
              kind: "mcp" as const,
              name: "Unique",
              description: "",
              domain: "private.example.co.uk",
            },
          ]),
        );
        expect(atoms.get(catalogIconDomainsAtom(catalog))).toEqual(
          new Map([
            ["same brand", null],
            ["unique", "example.co.uk"],
          ]),
        );
      }),
    ),
);

it.effect(
  "on-demand Markdown preserves safe links, GFM, relative skill files and readable fallback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const atoms = yield* registry;
        const text =
          "# Guide\n\n<script>unsafe()</script>\n\n[Unsafe](javascript:unsafe()) [External](https://example.com)\n\n- [x] Checked";
        const pending = renderToStaticMarkup(
          <RegistryContext.Provider value={atoms}>
            <ToolMarkdown>{text}</ToolMarkdown>
          </RegistryContext.Provider>,
        );
        expect(pending).toContain('aria-busy="true"');
        expect(pending).toContain("&lt;script&gt;");
        expect(pending).not.toContain("<script>");
        yield* AtomRegistry.getResult(atoms, markdownRendererAtom);
        const tool = renderToStaticMarkup(
          <RegistryContext.Provider value={atoms}>
            <ToolMarkdown>{text}</ToolMarkdown>
          </RegistryContext.Provider>,
        );
        expect(tool).toContain("<h1>Guide</h1>");
        expect(tool).toContain(
          'href="https://example.com" target="_blank" rel="noopener noreferrer"',
        );
        expect(tool).toContain('type="checkbox"');
        expect(tool).not.toContain("<script>");
        expect(tool).not.toContain('href="javascript:');
        const skill = renderToStaticMarkup(
          <RegistryContext.Provider value={atoms}>
            <SkillContent
              document={{
                file: "SKILL.md",
                content: `---\nname: guide\n---\n${text}\n\n[Reference](references/guide.md) [Missing](missing.md) ![Remote](https://private.invalid/pixel.png)`,
                files: ["SKILL.md", "references/guide.md"],
              }}
              onFile={() => {}}
            />
          </RegistryContext.Provider>,
        );
        expect(skill).not.toContain("name: guide");
        expect(skill).toContain('type="button" class="text-left underline">Reference</button>');
        expect(skill).toContain("<span>Missing</span>");
        expect(skill).toContain("<span>Remote</span>");
        expect(skill).not.toContain("<img");
        expect(skill).not.toContain('href="javascript:');
        expect(skill).not.toContain("<script>");
      }),
    ),
);
