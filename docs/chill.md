# Chill mode

Enter with **☾ Chill** in the normal top bar, the command palette, or **⌘⇧C**
(Ctrl+Shift+C on other keyboards). Chill is observational: **project names appear
only when multiple projects are visible. There is no title, other text, counters,
status letters, tooltips or
panels; focusing one project hides its name.**
A glass dome contains a living miniature of the workspace while jobs continue.

Original retained artwork includes moss, stones, mushrooms, four botanical
silhouettes with stable jade, lilac, apricot, lagoon, rose and mint palettes,
and expressive cyber bugs. Projects become trees and pots. Each
real session, delegated worker or reported native subagent becomes one helper.
Reused workers stay one helper. Review, research and image tasks use bees,
moths and butterflies; coding helpers are beetles and root sessions ladybugs.
Provider, model, task, status and file information remain available to assistive
technology, without appearing as text on the scene.

Files appear from explicit supported tool evidence. Running reads or edits can
show foliage before success; completed tools confirm the timestamp. Confirmed
edits bloom. Shell commands and arbitrary text do not invent file targets.
Work without a known file uses a miniature terminal bench. Several bugs can
perch at one file. Idle bugs rest; uncertain work stops looking actively busy.
Waiting uses a small clock, and attention uses a warm lantern. Goal blossoms
require engine-verified milestones; decorative flowers do not indicate success.

Click a plant to focus it; click it again to return to overview. Bugs and file
foliage can also be selected. The camera frames the complete selected plant and
its perches inside the dome. The overview icon or Escape clears focus; Escape
again leaves Chill. The source icon returns to the real project/session or
changes view, where normal inspection and job controls are available. Chill
itself cannot cancel or change work.

Quiet icon controls cycle atmosphere, freeze scenery, toggle optional wind,
reduce rendering cost and exit. Sound is muted on entry, starts only on a user
gesture and has a volume slider when enabled. Soft dusk, moonlight and warm
sunrise change the lighting. Freeze and reduced motion affect presentation
only. Text descriptions live in screen-reader names; icon controls do not show
native text tooltips. The command-palette shortcut exits Chill before opening
its normal text interface.

Failures, questions and blocked goals illuminate the garden's lanterns and a
persistent corner attention icon. Activating it opens the corresponding normal
session or goal screen. A disconnected activity feed also has an accessible
indicator and stops presenting uncertain work as actively running.

Leaves shrink with age. Active, pinned and selected files stay prominent;
24 leaves per plant are shown in overview, up to 80 in focus. Older files become
small background sprouts. A selected file can be pinned with the star icon.
Desktop shows up to six projects per page; the phone renderer shows one, with
icon arrows for paging. Both use the same authenticated activity snapshot API.

Detailed preferences are in the **normal Settings screen**, outside Chill:
atmosphere, recent-file window (1/6/24/72 hours), economy mode, volume, removing
pins and clearing recent activity. Confirmed file metadata is retained for seven
days, capped at 5000 files per project. Loaded/in-memory inactive history is
bounded to 20000 across projects. Pins affect presentation within that history.
Clearing activity removes metadata, never source files or transcripts.

OS/app reduced-motion settings stop animation. Economy mode caps animation at
30 fps and reduces resolution and particles. Hidden views stop polling and
rendering. Unsupported/lost graphics use a still illustration with the same
project-name visibility rule, shared selection and accessible activity inspection. Leaving Chill or
changing skins disposes audio, renderer, ticker, observers and event listeners.
The regular interface stays mounted, preserving the composer and transcript.

## Code boundaries

- `crates/thingmaker-supervisor/src/activity/`: neutral ingestion, structured file
  evidence, replay/lag recovery, actor lifecycle and bounded snapshots.
- `crates/thingmaker-supervisor/src/storage/activity.rs`: seven-day metadata and
  schema migration 20.
- `apps/desktop/src-tauri/src/commands/activity.rs`: enrich snapshots with real
  jobs, goals, model and worktree information; desktop-only history clearing.
- `apps/desktop/src/chill/model.ts`: neutral project/actor/file projection,
  delegated-worker identity, freshness and worktree names.
- `apps/desktop/src/chill/ChillView.tsx`: shared selection, focus, source navigation,
  attention, accessibility and resource owners.
- `apps/desktop/src/chill/ChillPreferences.tsx`: detailed preferences rendered only
  in normal Settings, preserving the observational scene.
- `apps/desktop/src/chill/skins/types.ts` and `registry.ts`: small typed static
  skin contract, preference validation and safe default.
- `apps/desktop/src/chill/skins/terrarium/`: complete first skin, including
  retained Pixi artwork, botanical layouts, camera framing, animation and audio.

A future skin implements `ChillSkin` and registers a stable ID. It consumes
neutral projects and shared selection/focus, supplies its artwork/settings,
and returns owned renderer/audio instances with cleanup. It does not collect
activity or implement job control. The selected skin ID is persisted, missing
IDs fall back to Terrarium, and skin changes preserve shared state. No second
production skin or dynamic plugin framework is shipped.

## Verification and preview

`pnpm typecheck`, `pnpm test`, workspace Rust tests, host tests, Clippy and Mac
bundle builds cover the implementation. Provider integration tests use captured
Claude, Codex and Gemini protocol programs without calling paid services.
Coverage includes observer attachment/removal, replay-safe timestamps, terminal
and partial tool patches, failures, explicit paths, queued/reused workers, stale
state, skin fallback/switching, resource disposal, project-name-only rendering
and camera framing at all project positions. Native Mac rendering and activity connection
have been smoke-tested; browser artwork previews cover active bugs and focus.

During development, `/chill-preview.html` on Vite provides sample activity and
an artwork export control outside the scene. The page's title and
`data-preview="sample-activity"` identify it as a design fixture. It is excluded
from production build entries. Production Chill reads real activity only.

Physical Android behavior, live signed-in provider sessions and a 30-minute
frame-time/memory soak remain release checks on target hardware. Automated
builds do not establish those performance gates. The original plan's pixel
atlas was replaced with original retained vector artwork after image generation
hit the account limit; no external artwork/audio license is needed.
