# Task: openclaw — Matrix DM Detection Follow-up

| Feld    | Wert                     |
| ------- | ------------------------ |
| Branch  | `fix/matrix-dm-followup` |
| Agent   | `orchestrator:main`      |
| Status  | `active`                 |
| Started | 2026-03-08T21:30:00Z     |
| Updated | 2026-03-08T21:30:00Z     |

## Context

PR #31023 removed the `memberCount === 2` DM heuristic (the root cause fix from our PR #19736), but shipped without the safety nets that came from community testing. This leaves a regression: on homeservers with broken `m.direct`/`is_direct` (Conduit, Continuwuity), DMs are no longer detected at all. Users have confirmed the regression (drallgood, 2026-03-07). This task adds the missing pieces as a follow-up PR.

## Scope

### F1: Conservative fallback for broken DM flags (🔴 critical)

- **File(s):** `extensions/matrix/src/matrix/monitor/direct.ts`
- **Problem:** After #31023, if both `m.direct` and `is_direct` are missing/broken (observed on Conduit/Continuwuity), rooms fall through to "group" with no recovery. The `includeMemberCountInLogs` feature gate also prevents member count from even being fetched (defaults to false).
- **Expected behavior:** A two-signal fallback: `memberCount === 2` AND no `m.room.name` state event → classify as DM. Requires removing the `includeMemberCountInLogs` gate so member count is always available. Add `isMatrixNotFoundError` helper to distinguish missing state events (M_NOT_FOUND/404) from network/auth errors — only M_NOT_FOUND indicates "no room name" (→ likely DM), other errors should fall through to group classification.

### F2: Config override for explicitly configured rooms (🟡 notable)

- **File(s):** `extensions/matrix/src/matrix/monitor/handler.ts`
- **Problem:** Rooms in the groups config can still be classified as DMs by protocol flags. Users have no deterministic escape hatch — they can't tell openclaw "this is a group room" when DM detection is wrong.
- **Expected behavior:** Move `resolveMatrixRoomConfig()` before the DM check. If a room matches a non-wildcard config entry (`matchSource === "direct"`) and was classified as DM, override to group. Wildcards must NOT trigger the override (would break DM routing with `"*"` catch-all). DMs must never inherit group settings (skills, systemPrompt, autoReply).

### F3: parentPeer for DM room binding (🟢 minor)

- **File(s):** `extensions/matrix/src/matrix/monitor/handler.ts`
- **Problem:** DM conversations aren't bindable by room ID — only by sender. This means the same DM in different rooms can't be distinguished.
- **Expected behavior:** Pass `roomId` as `parentPeer` on DM routes (in `resolveAgentRoute` call) so conversations are bindable by room ID while preserving DM trust semantics.

### F4: Test coverage (🟡 notable)

- **File(s):** `extensions/matrix/src/matrix/monitor/direct.test.ts`, `extensions/matrix/src/matrix/monitor/rooms.test.ts`
- **Problem:** Only 3 tests for `direct.ts`. No coverage for: fallback path, error handling (M_NOT_FOUND vs network), priority ordering, edge cases.
- **Expected behavior:** Comprehensive tests for all detection paths, config override logic, and `matchSource` classification.

## Steps

| #   | Step                              | Status | Updated              |
| --- | --------------------------------- | ------ | -------------------- |
| 1   | Orchestrator: Branch + Task Setup | ✅     | 2026-03-08T21:30:00Z |
| 2   | Agent 1: Spec + Tests             | ⬚      | —                    |
| 3   | Orchestrator: Review Spec + Tests | ⬚      | —                    |
| 4   | Agent 2: Implementierung          | ⬚      | —                    |
| 5   | Orchestrator: Pre-merge Gate      | ⬚      | —                    |
| 6   | Merge + Nachbereitung             | ⬚      | —                    |

## Artifacts

_(nach Abschluss ausfüllen)_

## Log

- `21:30` — Task created, branch `fix/matrix-dm-followup` from upstream/main
- `21:30` — Upstream analysis complete: 46 commits since #31023, handler.ts heavily refactored (plugin-sdk migration)
