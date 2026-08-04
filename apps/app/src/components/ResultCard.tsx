import type { Run } from "@brevi/shared";
import { Plate } from "./Bits";
import { Branch, Comment, External, Merge } from "./Icons";

export function ResultCard({ run }: { run: Run }) {
  const result = run.result;
  if (!result) return null;

  const shipped = run.status === "completed";
  const accent = shipped ? "border-mint-500/30" : "border-ink-700";

  return (
    <section className={`panel animate-rise border-l-2 ${accent} p-4`}>
      <div className="flex items-center gap-2">
        <Plate className={shipped ? "text-mint-400" : "text-haze-600"}>
          {result.kind === "spike" ? "Research delivered" : "Result"}
        </Plate>
        <span className="h-px flex-1 bg-ink-700" />
      </div>

      <p className="mt-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-haze-100">
        {result.summary}
      </p>

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
    </section>
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
    mint: "border-mint-500/35 bg-mint-500/10 text-mint-400 hover:bg-mint-500/20",
    iris: "border-iris-400/35 bg-iris-400/10 text-iris-400 hover:bg-iris-400/20",
    plain: "border-ink-600 text-haze-300 hover:bg-ink-750 hover:text-haze-50",
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`plate inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1.5 transition-colors ${tones[tone]}`}
    >
      {children}
    </a>
  );
}
