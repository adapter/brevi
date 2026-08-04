import { useCallback, useEffect, useState } from "react";
import type { ArtifactRef } from "@brevi/shared";
import { artifactUrl } from "../lib/api";
import { bytes } from "../lib/format";
import { Plate, Section } from "./Bits";
import { Close, Doc, External, Film, Image, Terminal } from "./Icons";

export function Artifacts({ runId, artifacts }: { runId: string; artifacts: ArtifactRef[] }) {
  const shots = artifacts.filter((a) => a.type === "screenshot");
  const films = artifacts.filter((a) => a.type === "recording");
  const files = artifacts.filter((a) => a.type !== "screenshot" && a.type !== "recording");
  const [open, setOpen] = useState<number | null>(null);

  if (artifacts.length === 0) return null;

  return (
    <Section label="Artifacts" count={artifacts.length}>
      <div className="flex flex-col gap-3">
        {shots.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
            {shots.map((shot, i) => (
              <li key={shot.name}>
                <button
                  type="button"
                  onClick={() => setOpen(i)}
                  className="group block w-full overflow-hidden rounded-[5px] border border-ink-700 bg-ink-850 text-left transition-colors hover:border-ink-500"
                >
                  <img
                    src={artifactUrl(runId, shot.name)}
                    alt={shot.name}
                    loading="lazy"
                    className="aspect-16/10 w-full bg-ink-950 object-cover object-top"
                  />
                  <span className="flex items-center gap-2 border-t border-ink-700 px-2 py-1.5">
                    <Image className="size-3 shrink-0 text-haze-700" />
                    <span className="truncate font-mono text-[10.5px] text-haze-400 group-hover:text-haze-200">
                      {shot.name}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-haze-700">
                      {bytes(shot.size)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {films.map((film) => (
          <figure key={film.name} className="overflow-hidden rounded-[5px] border border-ink-700">
            <video
              src={artifactUrl(runId, film.name)}
              controls
              playsInline
              className="w-full max-w-3xl bg-ink-950"
            />
            <figcaption className="flex items-center gap-2 border-t border-ink-700 bg-ink-850 px-2.5 py-1.5">
              <Film className="size-3 shrink-0 text-haze-700" />
              <span className="truncate font-mono text-[10.5px] text-haze-400">{film.name}</span>
              <span className="ml-auto font-mono text-[10px] text-haze-700">
                {bytes(film.size)}
              </span>
            </figcaption>
          </figure>
        ))}

        {files.length > 0 && (
          <ul className="flex flex-col gap-px">
            {files.map((file) => (
              <li key={file.name}>
                <a
                  href={artifactUrl(runId, file.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="strip flex items-center gap-2.5 px-2.5 py-2 hover:border-ink-500 hover:bg-ink-800"
                >
                  {file.type === "log" ? (
                    <Terminal className="size-3.5 shrink-0 text-haze-600" />
                  ) : (
                    <Doc className="size-3.5 shrink-0 text-haze-600" />
                  )}
                  <span className="truncate font-mono text-[11.5px] text-haze-200">
                    {file.name}
                  </span>
                  <Plate className="text-haze-700">{file.type}</Plate>
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] text-haze-700">
                    {bytes(file.size)}
                  </span>
                  <External className="size-3 shrink-0 text-haze-700" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open !== null && (
        <Lightbox
          runId={runId}
          shots={shots}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </Section>
  );
}

function Lightbox({
  runId,
  shots,
  index,
  onIndex,
  onClose,
}: {
  runId: string;
  shots: ArtifactRef[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const shot = shots[index];

  const step = useCallback(
    (delta: number) => onIndex((index + delta + shots.length) % shots.length),
    [index, onIndex, shots.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  if (!shot) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={shot.name}
      className="fixed inset-0 z-50 flex flex-col bg-ink-950/94 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 cursor-zoom-out"
      />
      <div className="relative flex h-12 shrink-0 items-center gap-3 border-b border-ink-700 px-4">
        <span className="font-mono text-[12px] text-haze-200">{shot.name}</span>
        <span className="font-mono text-[11px] text-haze-700">{bytes(shot.size)}</span>
        {shots.length > 1 && (
          <span className="plate ml-2 text-haze-700">
            {index + 1} / {shots.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {shots.length > 1 && (
            <>
              <NavButton label="Previous screenshot" onClick={() => step(-1)}>
                ←
              </NavButton>
              <NavButton label="Next screenshot" onClick={() => step(1)}>
                →
              </NavButton>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            autoFocus
            className="rounded-[4px] border border-ink-600 p-1.5 text-haze-300 hover:bg-ink-750 hover:text-haze-50"
          >
            <Close className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center p-6">
        <img
          src={artifactUrl(runId, shot.name)}
          alt={shot.name}
          className="max-h-full max-w-full rounded-[5px] border border-ink-700 object-contain shadow-2xl shadow-black/60"
        />
      </div>
    </div>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded-[4px] border border-ink-600 px-2 py-1 font-mono text-[12px] text-haze-300 hover:bg-ink-750 hover:text-haze-50"
    >
      {children}
    </button>
  );
}
