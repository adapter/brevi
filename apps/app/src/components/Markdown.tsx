import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent-authored markdown (run summaries, research), rendered in the house
 * style. Styling rides descendant selectors so the markdown stays unstyled
 * semantic HTML; react-markdown escapes raw HTML by default.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div
      className={[
        "text-[13.5px] leading-relaxed text-haze-100",
        "[&_p]:my-1.5",
        "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[14.5px] [&_h1]:font-semibold [&_h1]:text-haze-50",
        "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-haze-50",
        "[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:text-haze-50",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_li]:marker:text-haze-600",
        "[&_code]:rounded-[3px] [&_code]:bg-ink-950/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-haze-200",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-ink-700 [&_pre]:bg-ink-950/70 [&_pre]:p-2.5",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_a]:text-haze-50 [&_a]:underline [&_a]:decoration-ink-500 hover:[&_a]:decoration-haze-400",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-ink-600 [&_blockquote]:pl-3 [&_blockquote]:text-haze-400",
        "[&_hr]:my-3 [&_hr]:border-ink-700",
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12.5px]",
        "[&_th]:border [&_th]:border-ink-700 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-haze-200",
        "[&_td]:border [&_td]:border-ink-700 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
        "[&_strong]:font-semibold [&_strong]:text-haze-50",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
