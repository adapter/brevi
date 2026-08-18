import type { Run } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Plate } from "./Bits";
import { Branch, External, Merge } from "./Icons";
import { Markdown } from "./Markdown";

/** The result summary, links, and branch chip for a run. Frameless: the caller supplies the card. */
export function ResultCard({ run }: { run: Run }) {
  const result = run.result;
  if (!result) return null;

  const shipped = run.status === "completed";

  return (
    <div>
      <div className="flex items-center gap-2">
        <Plate className={shipped ? "text-mint-400" : "text-haze-600"}>Result</Plate>
        <Separator className="flex-1" />
      </div>

      <div className="mt-2.5">
        <Markdown>{result.summary}</Markdown>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {result.prUrl && (
          <Link href={result.prUrl} tone="mint">
            <Merge className="size-3.5" />
            Open pull request
          </Link>
        )}
        <Link href={run.ticket.url} tone="plain">
          <External className="size-3" />
          {run.ticket.identifier} in Linear
        </Link>
        {result.branch && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-950/60 px-2 py-1.5 text-haze-300">
            <Branch className="size-3 text-haze-600" />
            <span className="font-mono text-[11px] leading-none select-all">{result.branch}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Link({
  href,
  tone,
  children,
}: {
  href: string;
  tone: "mint" | "plain";
  children: React.ReactNode;
}) {
  const tones = {
    mint: "border-mint-500/35 bg-mint-500/10 text-mint-400 hover:border-mint-500/35 hover:bg-mint-500/20 hover:text-mint-400",
    plain: "",
  };
  return (
    <Button
      variant="outline"
      size="plate"
      className={tones[tone]}
      render={<a href={href} target="_blank" rel="noreferrer" />}
    >
      {children}
    </Button>
  );
}
