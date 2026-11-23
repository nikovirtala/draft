import { memo, useEffect, useId, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SESSION_ID = /([0-7][0-9A-HJKMNP-TV-Z]{25})/g;
/** The parts of a hast tree this file touches. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}
/** Sets Kiro session ids in prose as `code.id`, as the plain-text renderer did. */
function rehypeSessionIds() {
  const visit = (node: HastNode): void => {
    if (node.children === undefined || node.tagName === "code" || node.tagName === "pre") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        return [child];
      }
      const parts = child.value.split(SESSION_ID);
      if (parts.length === 1) return [child];
      return parts
        .map((part, i): HastNode | null =>
          part === ""
            ? null
            : i % 2 === 1
              ? {
                  type: "element",
                  tagName: "code",
                  properties: { className: ["id"] },
                  children: [{ type: "text", value: part }],
                }
              : { type: "text", value: part },
        )
        .filter((n): n is HastNode => n !== null);
    });
  };
  return (tree: HastNode) => visit(tree);
}
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSessionIds];
function hastText(node: unknown): string {
  const n = node as HastNode | undefined;
  if (n === undefined) return "";
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hastText).join("");
}
/**
 * A message's text as GitHub-flavoured Markdown. Raw HTML stays text and react-markdown drops
 * unsafe URLs; links open in the system browser (the main process denies in-window navigation).
 * A ```mermaid block renders as a diagram once the message is complete (`live` is false).
 */
export const Markdown = memo(function Markdown({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) {
  const components: Components = {
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    // A code block is a <pre> holding one <code>; inline code keeps the default rendering.
    pre: ({ node }) => {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
      const classes = code?.properties?.className;
      const className = Array.isArray(classes) ? classes.join(" ") : undefined;
      const lang = /language-(\S+)/.exec(className ?? "")?.[1];
      const source = hastText(code).replace(/\n$/, "");
      if (lang === "mermaid" && !live) return <Mermaid source={source} />;
      return (
        <pre className="code">
          <code className={className}>{source}</code>
        </pre>
      );
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
type MermaidApi = typeof import("mermaid").default;
let mermaidReady: Promise<MermaidApi> | null = null;
/** Loads mermaid on first use: it is large, and most messages have no diagram. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: v("--font-sans"),
      themeVariables: {
        fontFamily: v("--font-sans"),
        fontSize: "13px",
        background: v("--page"),
        primaryColor: v("--moved-fill"),
        primaryBorderColor: v("--moved-mark"),
        primaryTextColor: v("--ink"),
        secondaryColor: v("--surface"),
        tertiaryColor: v("--raised"),
        lineColor: v("--muted"),
        textColor: v("--text"),
      },
    });
    return mermaid;
  });
  return mermaidReady;
}
function Mermaid({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    let current = true;
    loadMermaid()
      .then((m) => m.render(id, source))
      .then(
        (r) => {
          if (current) setOut({ svg: r.svg });
        },
        (err: unknown) => {
          if (current) setOut({ error: err instanceof Error ? err.message : String(err) });
        },
      );
    return () => {
      current = false;
    };
  }, [id, source]);
  if (out !== null && "svg" in out) {
    return (
      <figure
        className="mermaid"
        data-testid="mermaid"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's strict security level sanitizes its SVG
        dangerouslySetInnerHTML={{ __html: out.svg }}
      />
    );
  }
  return (
    <figure className="mermaid source">
      <pre className="code">
        <code className="language-mermaid">{source}</code>
      </pre>
      {out !== null && <figcaption>This diagram didn’t render: {out.error}</figcaption>}
    </figure>
  );
}
