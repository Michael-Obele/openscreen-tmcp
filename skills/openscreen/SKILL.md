---
name: openscreen
description: Edit a screen recording in the OpenScreen app through the openscreen-tmcp MCP tools — cut silences, tighten pacing, place zooms on clicks, fix captions, add annotations, move clips. Use whenever the user asks to edit, tighten, polish, trim, caption or zoom a screen recording, or refers to "the recording", "the take", "my demo video", "dead air", or an OpenScreen project.
---

# Editing video in OpenScreen

You drive the **OpenScreen** app, which has a screen recording open in its editor. Your tools act on that live document. Every edit lands immediately and the user can undo it with `Ctrl/Cmd + Z`.

## Start every session the same way

1. `read` with `action: "project"` — see the assets, the placed clips, and existing trims/modifiers. **Never edit blind.**
2. If the user talks about what was _said_, `read` with `action: "transcript"` (or `"words"` for word-level ids).
3. Then act.

## The one rule that causes the most damage

**There are two time bases. Do not mix them.**

| Thing                                               | Base                | Meaning                                                              |
| --------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| clips, `setRange`, all `trim` actions               | **SOURCE seconds**  | Position inside the original recording file                          |
| zooms, speed, annotations, camera, audio (`effect`) | **VIRTUAL seconds** | Position on the edited timeline, _after_ clips and trims are applied |

Cutting 10 seconds out of the middle of the first clip moves every later zoom 10 seconds earlier on the virtual timeline. So **order matters**:

> **Cut first, then decorate.** Do all trimming, then place zooms/annotations/audio. If you must add an effect before cutting, re-check it afterwards with `read action: "project"`.

## Deletions are real deletions

Use `trim action: "remove"` for a trim, `clip action: "remove"` for a clip, `effect action: "remove"` for a modifier. **Never** fake a deletion by re-adding something or zeroing it out — that leaves the element in the document and misreports what you did.

## Recipes

### Tighten pacing / cut dead air

1. `read action: "transcript"` → the **silence** segments give you the gaps (start/end).
2. `trim` with `action: "addMany"` and the whole list in **one** call — not one call per gap.
3. Only include gaps actually worth removing (roughly ≥ 0.4 s). Leave short breaths; a totally gapless take sounds robotic.
4. Re-`read` to confirm.

### Zoom on the places that matter

- Fastest, most reliable: `read action: "project"` and look at the recorded clicks (auto-zoom in the app is planned from clicks).
- Cursor-driven: if `assets[].hasCursorTelemetry` is true, `read action: "cursor"` returns where the pointer went over time. Dwells and direction changes tell you where attention was — place zooms there.
- Then `effect` with `action: "addMany"`-style batching via `regions`, or one `action: "add"` per span.

**`depth` is an ordinal, not a multiplier:** `1`→1.25×, `2`→1.50×, `3`→1.80×, `4`→2.20×, `5`→3.50×, `6`→5.00×. Asking for `depth: 2` gives **1.50×**, not 2×.

`focusX`/`focusY` are **0–1 fractions of the frame**, not pixels. `0.5, 0.5` is centred.

### Fix captions

1. `read action: "words"` to get word ids.
2. `caption` with `wordId` + corrected `text`, one word at a time.
   Captions are rendered from this transcript, so a correction changes the burned-in text.

### Many edits at once

Use `apply` to send an ordered list of operations in a single call. It is **ordered, not atomic**: on failure it stops and tells you exactly which operations landed. Never describe it as "all or nothing".

## Time bases in one line

`trim` and `clip sourceStartSec/sourceEndSec` = **source**. Everything in `effect` = **virtual**.

## When something fails

- _"not reachable"_ → the OpenScreen app is closed, or AI settings → MCP server is off.
- _"Project edits"_ (upstream wording) → edits are switched off in OpenScreen's MCP server section. Tell the user; do not retry.
- _"token rejected"_ → the token was regenerated. Tell the user to regenerate and update their MCP config.

Report the real reason. Never summarise an upstream refusal into something vaguer.
