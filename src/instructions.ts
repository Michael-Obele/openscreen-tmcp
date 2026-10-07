/**
 * The condensed `instructions` string carried on `initialize` (target < 1 KB).
 *
 * This is the guardrail set worth paying for on every turn: the two time
 * bases, the ordering rule, honest deletion, and the honesty rules. Upstream's
 * ~4 KB block is deliberately *not* forwarded — removing that cost is half
 * the point of this proxy.
 */
export const INSTRUCTIONS = [
  "openscreen-tmcp: 6 tools proxy OpenScreen’s live editor document. Every edit is real, saved, undoable in-app (Ctrl/Cmd+Z).",
  "TIME BASES — never mix: trim times and clip sourceStartSec/sourceEndSec are SOURCE seconds (inside the original file); effect spans (zoom/speed/annotation/camera/audio) are VIRTUAL seconds (on the edited timeline, after cuts).",
  'ORDER — cut first, then decorate: trims shift later virtual positions, so re-read action:"project" after cutting if effects exist.',
  'Start edits with read action:"project"; reads are free (readOnlyHint).',
  "Deletions use the real remove actions — never fake one by re-adding or zeroing.",
  "effect zoom depth is an ordinal 1-6 (1.25x…5x), not a multiplier; focusX/focusY are 0-1 frame fractions.",
  "apply is ordered, NOT atomic: it stops at the first failure (stopOnError default true), reports applied/failedAt, rolls nothing back.",
  'Errors carry OpenScreen’s own wording (often the "Project edits" switch being off) — relay it verbatim, never paraphrased.',
].join("\n");
