/**
 * The model choices the create/edit forms offer for an agent definition. The
 * value is what rides in `metadata.model` → `claude -p --model <value>` for the
 * PROGRAMMATIC backend (a `channel`-backend turn runs in the operator's own
 * session, whose model they control). Empty value = no `--model` flag, so the
 * turn inherits Claude Code's own default.
 *
 * We offer the CC aliases (`opus`/`sonnet`/`haiku`) rather than pinned ids so a
 * def follows the latest of each family without an edit; an operator who wants a
 * specific build can still hand-write a full id in the def note's `metadata.model`
 * (the daemon accepts any well-formed value).
 */
export interface ModelOption {
  /** The `--model` value (empty = inherit Claude Code's default). */
  value: string;
  label: string;
}

// Labels intentionally carry NO version number — the values are CC aliases that
// follow the latest build of each family, so a pinned "4.8" would rot (and lie)
// the moment a newer Opus ships. The family + capability descriptor stays true.
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { value: "", label: "Default (Claude Code's default)" },
  { value: "opus", label: "Opus — most capable" },
  { value: "sonnet", label: "Sonnet — balanced" },
  { value: "haiku", label: "Haiku — fastest" },
];

/**
 * A human label for a stored model value (for read-only display). A value not in
 * the option list (e.g. a hand-written full id like `claude-opus-4-8`) renders
 * as itself. Empty/undefined → the "Default" label.
 */
export function modelLabel(value: string | undefined): string {
  if (!value) return "Default";
  return MODEL_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
