"use client";

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Element, ElementContent, Root, RootContent } from "hast";
import { CopyButton } from "./CopyButton";

/* ---------------------------------------------------------------------------
   The copilot's answers, rendered from Markdown.

   Nothing the model writes is ever treated as HTML: react-markdown builds
   React elements from the syntax tree, raw HTML in the text is not rendered,
   and link targets pass through its URL filter (no javascript: links). On
   top of plain GitHub-flavoured Markdown the desk understands three things the
   copilot is told to write:

     ```metrics      → stat cards, "Label | Value | note" per line
     > [!KEY] …      → a highlighted callout (also NOTE, TIP, WARNING, …)
     ## Section      → collapsible sections when an answer has two or more;
                       one headed "Details" starts collapsed
--------------------------------------------------------------------------- */

type Node = Root | RootContent | ElementContent;

function textOf(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if ("children" in node) return (node.children as Node[]).map(textOf).join("");
  return "";
}

function isElement(node: Node | undefined, tag?: string): node is Element {
  return node?.type === "element" && (tag === undefined || node.tagName === tag);
}

const CALLOUTS: Record<string, string> = {
  key: "Key takeaway",
  takeaway: "Key takeaway",
  summary: "Summary",
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
  risk: "Risk",
};

const COLLAPSED_SECTION = /^(details|supporting detail|method|methodology|full data|appendix)\b/i;

// Turns "> [!KEY]" blockquotes into callouts and groups an answer's "## "
// sections into collapsible blocks.
function rehypeDeskBlocks() {
  return (tree: Root) => {
    const walk = (node: Node) => {
      if (isElement(node, "blockquote")) markCallout(node);
      if ("children" in node) (node.children as Node[]).forEach(walk);
    };
    walk(tree);

    const sections = tree.children.filter((n) => isElement(n, "h2")).length;
    if (sections < 2) return;

    const out: RootContent[] = [];
    let current: Element | null = null;
    for (const node of tree.children) {
      if (isElement(node, "h2")) {
        const title = textOf(node).trim();
        current = {
          type: "element",
          tagName: "details",
          properties: { dataSection: COLLAPSED_SECTION.test(title) ? "collapsed" : "open" },
          children: [{ type: "element", tagName: "summary", properties: {}, children: [node] }],
        };
        out.push(current);
      } else if (current) {
        current.children.push(node as ElementContent);
      } else {
        out.push(node);
      }
    }
    tree.children = out;
  };
}

function markCallout(quote: Element) {
  const first = quote.children.find((c) => isElement(c, "p")) as Element | undefined;
  const lead = first?.children[0];
  if (!first || lead?.type !== "text") return;
  const match = lead.value.match(/^\s*\[!([a-z]+)\][ \t]*\n?/i);
  if (!match) return;
  const kind = match[1].toLowerCase();
  if (!CALLOUTS[kind]) return;

  lead.value = lead.value.slice(match[0].length);
  if (!lead.value) first.children.shift();
  if (first.children[0] && isElement(first.children[0], "br")) first.children.shift();
  if (first.children.length === 0) quote.children.splice(quote.children.indexOf(first), 1);
  quote.properties = { ...quote.properties, dataCallout: kind };
}

/* --------------------------------------------------------------- components */

function Section({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  // Kept in state so a re-render while the answer streams does not undo the
  // person's choice.
  const [open, setOpen] = useState(!collapsed);
  return (
    <details className="md-section" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {children}
    </details>
  );
}

function Metrics({ text }: { text: string }) {
  const rows = text
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && cells[0] && cells[1]);
  if (rows.length === 0) return null;
  return (
    <div className="md-metrics">
      {rows.slice(0, 8).map(([label, value, note], i) => {
        const tone = note ? (/^\+/.test(note) ? "up" : /^[-−]/.test(note) ? "down" : "") : "";
        return (
          <div className="md-metric" key={i}>
            <span className="md-metric-label">{label}</span>
            <span className="md-metric-value num">{value}</span>
            {note && <span className={`md-metric-note ${tone}`}>{note}</span>}
          </div>
        );
      })}
    </div>
  );
}

function CodeBlock({ lang, text, children }: { lang: string | null; text: string; children: ReactNode }) {
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang ?? "text"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}

// react-markdown hands every component the syntax-tree node; it is not a DOM
// attribute, so it is dropped before props are spread onto an element.
function domProps<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const copy = { ...props };
  delete copy.node;
  return copy;
}

const components: Components = {
  h1: (props) => <h2 {...domProps(props)} />,
  a: (props) => {
    const { href, children, ...rest } = domProps(props);
    const external = typeof href === "string" && /^https?:/i.test(href);
    return (
      <a
        href={href}
        {...rest}
        {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
      >
        {children}
        {external && (
          <span className="md-ext" aria-label="(opens in a new tab)">
            ↗
          </span>
        )}
      </a>
    );
  },
  // The page's security policy only loads images from the desk itself; a
  // remote image in an answer is shown as its description instead.
  img: ({ alt }) => <span className="subtle">[{alt || "image"}]</span>,
  table: (props) => (
    <div className="md-table" role="region" aria-label="Table" tabIndex={0}>
      <table {...domProps(props)} />
    </div>
  ),
  blockquote: ({ node, children }) => {
    const kind = node?.properties?.dataCallout;
    if (typeof kind === "string" && CALLOUTS[kind]) {
      return (
        <aside className={`md-callout md-callout-${kind}`} aria-label={CALLOUTS[kind]}>
          <span className="md-callout-title">{CALLOUTS[kind]}</span>
          {children}
        </aside>
      );
    }
    return <blockquote>{children}</blockquote>;
  },
  details: ({ node, children }) => (
    <Section collapsed={node?.properties?.dataSection === "collapsed"}>{children}</Section>
  ),
  pre: ({ node, children }) => {
    const code = node?.children.find((c) => isElement(c, "code"));
    const classes = isElement(code) ? ((code.properties?.className as string[] | undefined) ?? []) : [];
    const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
    const text = textOf(code).replace(/\n$/, "");
    if (lang === "metrics") return <Metrics text={text} />;
    return (
      <CodeBlock lang={lang} text={text}>
        {children}
      </CodeBlock>
    );
  },
};

const rehypePlugins = [
  [rehypeHighlight, { detect: false, plainText: ["metrics", "text", "txt"] }],
  rehypeDeskBlocks,
] as const;
const remarkPlugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rehypePlugins={rehypePlugins as any}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
