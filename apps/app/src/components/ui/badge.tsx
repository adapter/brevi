import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
  A badge is a quiet pill chip: hairline edge, sentence-case text-size label.
  Mono values inside a badge keep their own "font-mono" reset.
*/
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent px-2 py-1 text-[11px] leading-none font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "border-ember-600/40 bg-ember-500/10 text-ember-500 [a]:hover:bg-ember-500/20",
        secondary: "border-ink-700 bg-ink-800 text-haze-300 [a]:hover:bg-ink-750",
        destructive:
          "border-rust-500/35 bg-rust-500/10 text-rust-400 [a]:hover:bg-rust-500/20",
        outline: "border-ink-600 text-haze-400 [a]:hover:bg-ink-750",
        ghost: "text-haze-600",
        link: "text-ember-500 underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
