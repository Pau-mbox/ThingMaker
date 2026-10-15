# ADR-011: Chill activity and replaceable visual skins

Status: Accepted · 12 October 2026

Chill visualizes ongoing work while the normal interface remains mounted. It
must reflect the same sessions, workers, native subagents and goals, and future
visual worlds must be able to reuse that information.

The Rust supervisor owns a neutral `ActivityService`. It subscribes when a
session actor is registered, independently of transcript subscriptions and
renderer lifetime. Ordered events, attachment generations and tool patches
produce bounded actor/file summaries. Only explicit, recognized tool fields
provide file evidence. A successful tool result confirms recency; replay does
not make a historical file fresh. Persistence retains file metadata, never tool
content or fictional running actors.

The existing authenticated command bridge exposes `activity_snapshot`. The UI
polls bounded snapshots every 750 ms locally and 1500 ms remotely, with no
overlapping requests. This reuses the established transport rather than adding
another subscription protocol. Session cursors and lag recovery live in Rust.

React owns shared Chill behavior: selection, focus, source navigation, attention,
accessible inspection, settings, reduced motion and cleanup. Chill is entirely
observational, showing only project names when several projects are visible; detailed preferences and job controls live in the
normal interface. Its model uses
projects, actors and files. It never chooses a botanical shape or bug species.

A small static `ChillSkin` registry provides a renderer factory, optional audio
factory, a still-image component, presentation terms, validated
settings and page sizes. The first and only production entry is `terrarium`.
Its module owns artwork, layouts, activity-to-bug mapping, foliage aging,
animation and sound. No dynamic plugin loading or second skin is included.

The selected skin ID is persisted; missing IDs fall back to Terrarium. Changing
skins replaces and disposes rendering/audio resources while shared activity,
selection and focus remain mounted. No skin has authority to launch, cancel or
change a job. Source navigation returns to the normal interface for job controls.

Pixi is loaded only on entering the visual renderer. Its static WebGL shader
and uniform implementations support the application's existing CSP; the CSP is
not weakened. Rendering pauses when hidden, respects reduced motion and offers
an economy mode. Unsupported/lost graphics fall back to an illustrated still
view with the same accessible activity selection and source navigation.

Tests cover neutral projection, tool evidence/replay and observer lifecycle,
provider bridge fixtures, recency/density, preferences and fallback, shared
inspection and skin replacement cleanup. Physical phone testing and long-run
frame/memory measurements remain release checks, separate from build success.
