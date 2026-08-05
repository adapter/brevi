import type { Run } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Plate } from "./Bits";
import { Branch, Comment, External, Merge } from "./Icons";
import { Markdown } from "./Markdown";

export function ResultCard({ run }: { run: Run }) {
  const result = run.result;
  if (!result) return null;

  const shipped = run.status === "completed";
  const accent = shipped ? "border-mint-500/30" : "border-ink-700";

  return (
    <Card className={`block animate-rise border-l-2 ${accent} p-4`}>
      <div className="flex items-center gap-2">
        <Plate className={shipped ? "text-mint-400" : "text-haze-600"}>
          {result.kind === "spike" ? "Research delivered" : "Result"}
        </Plate>
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
        {result.commentUrl && (
          <Link href={result.commentUrl} tone="iris">
            <Comment className="size-3.5" />
            Read the write-up
          </Link>
        )}
        <Link href={run.ticket.url} tone="plain">
          <External className="size-3" />
          {run.ticket.identifier} in Linear
        </Link>
        {result.branch && (
          <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-ink-600 bg-ink-950/60 px-2 py-1.5 text-haze-300">
            <Branch className="size-3 text-haze-600" />
            <span className="font-mono text-[11px] leading-none select-all">{result.branch}</span>
          </span>
        )}
      </div>
    </Card>
  );
}

function Link({
  href,
  tone,
  children,
}: {
  href: string;
  tone: "mint" | "iris" | "plain";
  children: React.ReactNode;
}) {
  const tones = {
    mint: "border-mint-500/35 bg-mint-500/10 text-mint-400 hover:border-mint-500/35 hover:bg-mint-500/20 hover:text-mint-400",
    iris: "border-iris-400/35 bg-iris-400/10 text-iris-400 hover:border-iris-400/35 hover:bg-iris-400/20 hover:text-iris-400",
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
