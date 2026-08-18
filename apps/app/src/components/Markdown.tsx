import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * GitHub allows a slice of raw HTML in markdown (details/summary disclosure
 * blocks, images, task-list checkboxes); render that slice and strip the
 * rest. Sanitization runs after rehype-raw, so nothing script-shaped
 * survives into the tree.
 */
const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    input: ["type", "checked", "disabled"],
  },
};

/**
 * Relative URLs in GitHub-sourced markdown are relative to the page they came
 * from, not to brevi://app; resolve them against that page so links leave the
 * app and images load.
 */
function resolveUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * Agent-authored markdown (run summaries, research) and GitHub-sourced
 * markdown (PR bodies, comments), rendered in the house style. Styling rides
 * descendant selectors so the markdown stays unstyled semantic HTML. Raw
 * HTML is parsed then sanitized to GitHub's subset; template comments
 * (`<!-- ... -->`) disappear instead of showing as text.
 *
 * `github` additionally treats single newlines as hard breaks, matching how
 * GitHub renders issue and PR prose (but not how ordinary markdown wraps,
 * so agent summaries leave it off). `baseUrl` is the GitHub page the
 * markdown came from, used to resolve relative links and images.
 */
export function Markdown({
  children,
  github = false,
  baseUrl,
}: {
  children: string;
  github?: boolean;
  baseUrl?: string;
}) {
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
        // GFM task lists: GitHub drops the bullet and shows the checkbox.
        "[&_li:has(>input)]:list-none [&_li_input]:mr-1.5 [&_li_input]:size-3 [&_li_input]:translate-y-[1.5px] [&_li_input]:accent-ember-500",
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
        "[&_del]:text-haze-500",
        "[&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-lg",
        "[&_details]:my-2 [&_details]:rounded-lg [&_details]:border [&_details]:border-ink-700 [&_details]:px-3 [&_details]:py-2",
        "[&_summary]:cursor-pointer [&_summary]:text-[12.5px] [&_summary]:font-medium [&_summary]:text-haze-200",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={github ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
        components={
          baseUrl === undefined
            ? undefined
            : {
                // Component overrides see raw-HTML elements too, which the
                // urlTransform hook does not.
                a: ({ node: _node, href, ...props }) => (
                  <a {...props} href={resolveUrl(href, baseUrl)} />
                ),
                img: ({ node: _node, src, ...props }) => (
                  <img {...props} src={resolveUrl(src, baseUrl)} />
                ),
              }
        }
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
