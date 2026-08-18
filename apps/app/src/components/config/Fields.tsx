import { useId, useState, type ReactNode } from "react";
import { MASKED_SECRET } from "@brevi/shared/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { defaultPlaceholder, needsRestart, type SettingsDraft } from "../../lib/settings";
import { Check, Close, Minus, Plus, Refresh, Warn } from "../Icons";

/**
 * The building blocks every settings subpage is assembled from: a card that
 * owns one config subsection and saves it explicitly, and the field rows
 * inside it. Nothing here is generated from the schema at runtime; adding a
 * config field means adding its control by hand, so the help text can say
 * what the field actually does.
 */

const INPUT_CLASS =
  "h-7 rounded-md border-ink-600 bg-ink-950/70 px-2 font-mono text-[12px] text-haze-100 placeholder:text-haze-700 md:text-[12px]";

/** One config subsection, saved as a unit. Enter anywhere inside submits it. */
export function SettingsCard({
  title,
  description,
  draft,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  draft: SettingsDraft;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="gap-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.dirty && !draft.invalid && !draft.saving) draft.save();
        }}
      >
        <CardHeader className="gap-0">
          <h3 className="text-[13px] font-semibold text-haze-50">
            {title}
          </h3>
          {description && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-haze-400">{description}</p>
          )}
        </CardHeader>
        <CardContent className="mt-1.5 flex flex-col">{children}</CardContent>

        {(draft.dirty || draft.error || draft.applied) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-ink-700 px-(--card-spacing) pt-2.5">
            {draft.dirty && (
              <>
                <Button type="submit" size="plate" disabled={draft.saving || draft.invalid}>
                  {draft.saving ? "Saving" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="plate"
                  onClick={draft.discard}
                  disabled={draft.saving}
                  className="hover:bg-transparent hover:text-haze-300"
                >
                  Discard
                </Button>
              </>
            )}
            {draft.error && (
              <p className="flex min-w-0 items-start gap-1.5 text-[12px] leading-relaxed text-rust-400">
                <Warn className="mt-px size-3 shrink-0" />
                {draft.error}
              </p>
            )}
            {!draft.dirty && draft.applied === "live" && (
              <p className="flex items-center gap-1.5 text-[12px] text-mint-400">
                <Check className="size-3 shrink-0" />
                Saved. Applies to the next run.
              </p>
            )}
            {!draft.dirty && draft.applied === "restart" && (
              <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-iris-400">
                <Warn className="mt-px size-3 shrink-0" />
                Saved to config.json. Restart brevi for it to take effect.
              </p>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

/**
 * Label, control, and the help text under it. Below md the control drops
 * beneath its label rather than squeezing next to it.
 */
export function FieldRow({
  label,
  help,
  path,
  draft,
  htmlFor,
  wide,
  children,
}: {
  label: string;
  help?: ReactNode;
  /** The config path this row edits; drives validation, restart badge, and reset. */
  path?: string;
  draft?: SettingsDraft;
  htmlFor?: string;
  /** Give the control the full row width (long paths, commands, tag lists). */
  wide?: boolean;
  children: ReactNode;
}) {
  const error = path && draft ? draft.issue(path) : undefined;
  const resettable = path && draft && !draft.isDefault(path);
  return (
    <div className="flex flex-col gap-1.5 border-t border-ink-700 py-2 first:border-t-0 first:pt-0 last:pb-0 md:flex-row md:items-start md:gap-4">
      <div className="flex min-w-0 items-center gap-1.5 md:flex-1 md:pt-1">
        {/* Controls that aren't a single focusable input (segments, radios,
            switches) label themselves with aria-label instead; a <label> with
            no target would just be an empty association. */}
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-[12px] font-medium text-haze-200"
          >
            {label}
          </label>
        ) : (
          <span className="text-[12px] font-medium text-haze-200">
            {label}
          </span>
        )}
        {path && needsRestart(path) && (
          <Badge variant="outline" title="Takes effect after brevi is restarted">
            restart
          </Badge>
        )}
      </div>
      <div className={`flex min-w-0 flex-col gap-1 ${wide ? "md:flex-1" : "md:w-[280px] md:shrink-0"}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 flex-1">{children}</div>
          {resettable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => draft.reset(path)}
              aria-label={`Reset ${label} to its default`}
              title="Reset to default"
            >
              <Refresh className="size-3" />
            </Button>
          )}
        </div>
        {error ? (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-rust-400">
            <Warn className="mt-px size-3 shrink-0" />
            {error}
          </p>
        ) : (
          help && <p className="text-[11.5px] leading-relaxed text-haze-700">{help}</p>
        )}
      </div>
    </div>
  );
}

/** Escape puts a field back to what the orchestrator last sent. */
function escapeReverts(draft: SettingsDraft, path: string) {
  return (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      draft.revert(path);
    }
  };
}

export function TextField({
  label,
  help,
  path,
  draft,
  placeholder,
  disabled,
  mono = true,
  wide,
  suggestions,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  wide?: boolean;
  /** Datalist completions, e.g. the models brevi is usually pointed at. */
  suggestions?: string[];
}) {
  const id = useId();
  const listId = `${id}-list`;
  const value = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft} htmlFor={id} wide={wide}>
      <Input
        id={id}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => draft.set(path, event.target.value)}
        onKeyDown={escapeReverts(draft, path)}
        placeholder={placeholder ?? defaultPlaceholder(path)}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={draft.issue(path) !== undefined}
        list={suggestions ? listId : undefined}
        className={mono ? INPUT_CLASS : `${INPUT_CLASS} font-sans`}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </FieldRow>
  );
}

/**
 * A field the schema marks optional: an empty box means "not set", which the
 * endpoint is told with null so the key is dropped rather than written as an
 * empty string.
 */
export function OptionalTextField({
  label,
  help,
  path,
  draft,
  placeholder,
  disabled,
  mono = true,
  wide,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  wide?: boolean;
}) {
  const id = useId();
  const value = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft} htmlFor={id} wide={wide}>
      <Input
        id={id}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => draft.set(path, event.target.value === "" ? null : event.target.value)}
        onKeyDown={escapeReverts(draft, path)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={draft.issue(path) !== undefined}
        className={mono ? INPUT_CLASS : `${INPUT_CLASS} font-sans`}
      />
    </FieldRow>
  );
}

export function NumberField({
  label,
  help,
  path,
  draft,
  unit,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  /** Rendered after the box: "min", "h", "s". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const raw = draft.value(path);
  const value = typeof raw === "number" ? raw : Number.NaN;
  const nudge = (delta: number) => {
    // Stepping up from an empty box should land on the smallest legal value,
    // not one step above it.
    if (Number.isNaN(value)) {
      draft.set(path, min ?? 0);
      return;
    }
    const next = value + delta;
    if (min !== undefined && next < min) return;
    if (max !== undefined && next > max) return;
    draft.set(path, next);
  };
  return (
    <FieldRow label={label} help={help} path={path} draft={draft} htmlFor={id}>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={Number.isNaN(value) ? "" : String(value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={draft.issue(path) !== undefined}
          onChange={(event) => {
            const next = event.target.value;
            // An empty box is mid-edit, not zero; keep it invalid instead of
            // silently writing a number the user never typed.
            draft.set(path, next === "" ? Number.NaN : Number(next));
          }}
          onKeyDown={escapeReverts(draft, path)}
          className={`${INPUT_CLASS} w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        />
        {unit && <span className="font-mono text-[11px] text-haze-700">{unit}</span>}
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => nudge(-step)}
            disabled={disabled || (min !== undefined && !Number.isNaN(value) && value <= min)}
            aria-label={`Decrease ${label}`}
          >
            <Minus className="size-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => nudge(step)}
            disabled={disabled || (max !== undefined && !Number.isNaN(value) && value >= max)}
            aria-label={`Increase ${label}`}
          >
            <Plus className="size-3" />
          </Button>
        </span>
      </div>
    </FieldRow>
  );
}

export interface Choice {
  value: string;
  label: string;
  /** One line under the option; radio groups only. */
  detail?: ReactNode;
}

/** Two to four mutually exclusive options, shown as one row of buttons. */
export function SegmentedField({
  label,
  help,
  path,
  draft,
  options,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  options: Choice[];
  disabled?: boolean;
}) {
  const current = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft}>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => {
          const active = current === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              size="xs"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => draft.set(path, option.value)}
              className={active ? "border-haze-300 text-haze-50" : "border-ink-600 text-haze-600"}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </FieldRow>
  );
}

/** Options that each need a sentence of explanation, stacked vertically. */
export function RadioField({
  label,
  help,
  path,
  draft,
  options,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  options: Choice[];
  disabled?: boolean;
}) {
  const current = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft} wide>
      <RadioGroup
        value={typeof current === "string" ? current : null}
        onValueChange={(next) => draft.set(path, next)}
        disabled={disabled}
        aria-label={label}
        className="gap-2"
      >
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 text-[12px] text-haze-200"
          >
            <RadioGroupItem value={option.value} className="mt-px shrink-0" />
            <span className="min-w-0">
              {option.label}
              {option.detail && (
                <span className="block text-[11.5px] leading-relaxed text-haze-700">
                  {option.detail}
                </span>
              )}
            </span>
          </label>
        ))}
      </RadioGroup>
    </FieldRow>
  );
}

/** The item value standing in for "no value"; Select can't hold null itself. */
const NONE = "\u0000none";

export function SelectField({
  label,
  help,
  path,
  draft,
  options,
  placeholder = "None",
  clearable,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  options: Choice[];
  placeholder?: string;
  /** Offer a "None" option that clears the (optional) field. */
  clearable?: boolean;
  disabled?: boolean;
}) {
  const current = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft}>
      <Select
        value={typeof current === "string" ? current : NONE}
        onValueChange={(next) => draft.set(path, next === NONE ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={label}
          className="w-full border-ink-600 bg-ink-950/70 text-[12px]"
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {clearable && <SelectItem value={NONE}>{placeholder}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

export function SwitchField({
  label,
  help,
  path,
  draft,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  disabled?: boolean;
}) {
  const current = draft.value(path);
  return (
    <FieldRow label={label} help={help} path={path} draft={draft}>
      <Switch
        checked={current === true}
        onCheckedChange={(next) => draft.set(path, next)}
        disabled={disabled}
        aria-label={label}
      />
    </FieldRow>
  );
}

/** A string array: type and press Enter (or comma) to add, click x to remove. */
export function TagField({
  label,
  help,
  path,
  draft,
  placeholder,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [pending, setPending] = useState("");
  const raw = draft.value(path);
  const tags = Array.isArray(raw) ? (raw as string[]) : [];

  const commit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    draft.set(path, [...tags, trimmed]);
  };

  return (
    <FieldRow label={label} help={help} path={path} draft={draft} htmlFor={id} wide>
      <div className="flex flex-col gap-1.5">
        {tags.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="gap-1 pr-1">
                  <span className="font-mono text-[11px] tracking-normal normal-case">{tag}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled}
                    onClick={() => draft.set(path, tags.filter((value) => value !== tag))}
                    aria-label={`Remove ${tag}`}
                    className="size-4 hover:bg-transparent hover:text-rust-400"
                  >
                    <Close className="size-2.5" />
                  </Button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <Input
          id={id}
          type="text"
          value={pending}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value;
            if (next.endsWith(",")) {
              commit(next.slice(0, -1));
              setPending("");
            } else {
              setPending(next);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter belongs to the tag box while it has text; only an empty
              // box lets the card's submit through.
              if (pending.trim()) {
                event.preventDefault();
                commit(pending);
                setPending("");
              }
            } else if (event.key === "Backspace" && pending === "" && tags.length > 0) {
              event.preventDefault();
              draft.set(path, tags.slice(0, -1));
            } else if (event.key === "Escape") {
              event.preventDefault();
              setPending("");
              draft.revert(path);
            }
          }}
          onBlur={() => {
            if (pending.trim()) {
              commit(pending);
              setPending("");
            }
          }}
          className={INPUT_CLASS}
        />
      </div>
    </FieldRow>
  );
}

/**
 * A write-only secret: the orchestrator only ever sends back a mask, so the
 * stored value is shown as dots and can be replaced but never read back.
 */
export function SecretField({
  label,
  help,
  path,
  draft,
  placeholder,
}: {
  label: string;
  help?: ReactNode;
  path: string;
  draft: SettingsDraft;
  placeholder?: string;
}) {
  const id = useId();
  const raw = draft.value(path);
  const stored = raw === MASKED_SECRET;
  const [replacing, setReplacing] = useState(false);

  if (stored && !replacing) {
    return (
      <FieldRow label={label} help={help} path={path} draft={draft}>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] tracking-[0.25em] text-haze-400">••••••••</span>
          <Button
            type="button"
            variant="outline"
            size="plate"
            // Only reveals the box. Nothing is written until something is
            // typed, so a stray click can't wipe a stored secret on the next
            // save of an unrelated field in the same card.
            onClick={() => setReplacing(true)}
            className="ml-auto"
          >
            Replace
          </Button>
        </div>
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} help={help} path={path} draft={draft} htmlFor={id}>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="password"
          value={typeof raw === "string" && raw !== MASKED_SECRET ? raw : ""}
          onChange={(event) => draft.set(path, event.target.value)}
          onKeyDown={escapeReverts(draft, path)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={draft.issue(path) !== undefined}
          className={INPUT_CLASS}
        />
        {replacing && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              draft.revert(path);
              setReplacing(false);
            }}
            aria-label={`Keep the stored ${label}`}
            title="Keep the stored value"
          >
            <Close className="size-3" />
          </Button>
        )}
      </div>
    </FieldRow>
  );
}

/** The page heading every /config subpage opens with. */
export function SectionIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="plate text-haze-400">{title}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-haze-400">{children}</p>
    </div>
  );
}

/** Fields that are rarely touched, folded away until asked for. */
export function Advanced({ label = "Advanced", children }: { label?: string; children: ReactNode }) {
  return (
    <Collapsible className="border-t border-ink-700 pt-2.5">
      <CollapsibleTrigger className="group/adv flex cursor-pointer items-center gap-1.5 py-1 text-[11px] font-medium text-haze-600 hover:text-haze-300">
        <span className="w-2.5 text-center font-mono text-[9px] transition-transform group-data-[panel-open]/adv:rotate-90">
          &#9656;
        </span>
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col">{children}</CollapsibleContent>
    </Collapsible>
  );
}
