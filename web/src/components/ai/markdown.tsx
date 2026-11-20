import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/* AI answers: Markdown (bold, lists, tables, code) with LaTeX math via KaTeX.
 * Styles: `.ai-md` in index.css. Raw HTML in answers is not rendered. */

// Models also write \( … \) and \[ … \]; remark-math only knows $ … $ and $$ … $$.
// Convert outside code spans/blocks so code samples stay untouched.
export function normalizeMath(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`)
    )
    .join("");
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="ai-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
