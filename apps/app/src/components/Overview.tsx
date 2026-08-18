import { Plate } from "./Bits";

/**
 * The main pane when no run is open. Runs themselves live in the sidebar and
 * at /runs/<id>, so this pane only orients: offline help, first-run guidance,
 * or a pointer at the sidebar.
 */
export function Overview({
  offline,
  hasRuns,
  missingRun,
}: {
  /** The orchestrator has never answered on this page load. */
  offline: boolean;
  hasRuns: boolean;
  /** The URL names a run the orchestrator does not know. */
  missingRun: boolean;
}) {
  if (offline) {
    return (
      <Centered>
        <span className="inline-flex items-center gap-2 text-rust-400">
          <span className="inline-block size-[7px] rounded-full bg-rust-500" />
          <Plate>Orchestrator offline</Plate>
        </span>
        <h2 className="mt-2.5 text-[15px] text-haze-50">Mission Control lost its runtime</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
          Restart the orchestrator from the menu bar. This page reconnects on its own.
        </p>
      </Centered>
    );
  }

  if (missingRun) {
    return (
      <Centered center>
        <p className="text-[13.5px] text-haze-300">This run does not exist</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-600">
          The link may be from another machine, or the run&apos;s history has been cleared. Pick a
          run from the sidebar instead.
        </p>
      </Centered>
    );
  }

  if (!hasRuns) {
    return (
      <Centered center>
        <p className="text-[13.5px] text-haze-300">No runs yet</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-600">
          Run a ticket from the queue, or leave brevi to pick one up on its next pass through
          Linear. Every run shows up in the sidebar.
        </p>
      </Centered>
    );
  }

  return (
    <Centered center>
      <p className="text-[13.5px] text-haze-300">Pick a run from the sidebar</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-600">
        Each run has its own page and URL; copy the address bar to share exactly what you are
        looking at.
      </p>
    </Centered>
  );
}

function Centered({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return (
    <div className="flex justify-center px-8 py-14">
      <div className={center ? "max-w-sm text-center" : "max-w-md"}>{children}</div>
    </div>
  );
}
