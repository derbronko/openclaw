# Matrix DM Follow-up: Specification

## Overview

PR #31023 removed the `memberCount === 2` DM heuristic from `direct.ts` to fix false positives (explicitly configured 2-member group rooms being misclassified as DMs). However, the removal shipped without safety nets. This follow-up adds:

1. **Conservative fallback** for homeservers with broken/missing DM flags
2. **Config override** for explicitly configured rooms
3. **parentPeer** for DM room binding
4. **Comprehensive test coverage**

---

## F1: Conservative Fallback for Broken DM Flags (🔴 Critical)

### Intent

**Problem:** After the heuristic removal, if both `m.direct` account data AND `is_direct` member state are missing or broken (observed on Conduit/Continuwuity homeservers), rooms fall through to "group" classification with no recovery mechanism.

**Why this matters:** Real DMs become unreachable on certain homeserver implementations. Users lose access to DM conversations.

**Solution:** Add a two-signal conservative fallback at the end of `isDirectMessage()`:

- IF `memberCount === 2` AND the room has no `m.room.name` state event → classify as DM
- The fallback only triggers when BOTH protocol-level signals (m.direct + is_direct) fail
- "No room name" is detected via M_NOT_FOUND/404 error, distinguishing it from network/auth errors

### Constraints

**MUST NOT change:**

- Priority order: `m.direct` > `is_direct` > fallback
- The 3 existing tests in `direct.test.ts` MUST remain green
- Fallback must be **conservative**: ambiguous cases (network errors, auth failures) → classify as group

**MUST change:**

- Remove the `includeMemberCountInLogs` option gate so member count is always fetched
- Member count is required for the fallback logic

### Acceptance Criteria

**AC-1.1:** `includeMemberCountInLogs` option is removed from `DirectRoomTrackerOptions` type

**AC-1.2:** Member count is ALWAYS fetched (no conditional gating)

**AC-1.3:** A new helper function `isMatrixNotFoundError(err: unknown): boolean` exists that:

- Returns `true` if `err.errcode === "M_NOT_FOUND"` OR `err.statusCode === 404`
- Returns `false` otherwise
- Handles cases where `err` is not an object

**AC-1.4:** `isDirectMessage()` attempts to fetch `m.room.name` state event for rooms with `memberCount === 2`

**AC-1.5:** If `m.room.name` fetch throws `M_NOT_FOUND` or 404 → no room name exists → classify as DM

**AC-1.6:** If `m.room.name` fetch throws network/auth error → ambiguous → classify as group (conservative)

**AC-1.7:** If `m.room.name` exists AND is non-empty (after trimming) → classify as group

**AC-1.8:** If `m.room.name` exists BUT is empty/whitespace-only → treated as "no name" → classify as DM

**AC-1.9:** If `memberCount !== 2` → never use fallback → classify as group

**AC-1.10:** Priority order is strictly enforced:

1. `m.direct` account data → DM (return early)
2. `is_direct` member state → DM (return early)
3. Fallback (memberCount === 2 AND no room name) → DM
4. Default → group

**AC-1.11:** All existing tests in `direct.test.ts` remain green

### Affected Files

**Source:**

- `extensions/matrix/src/matrix/monitor/direct.ts`

**Tests:**

- `extensions/matrix/src/matrix/monitor/direct.test.ts`

---

## F2: Config Override for Explicitly Configured Rooms (🟡 Notable)

### Intent

**Problem:** Currently, `resolveMatrixRoomConfig()` is called AFTER `isDirectMessage()` and only for non-DM rooms:

```typescript
const isDirectMessage = await directTracker.isDirectMessage(...);
const isRoom = !isDirectMessage;

const roomConfigInfo = isRoom ? resolveMatrixRoomConfig(...) : undefined;
```

This means: if a room is classified as DM by protocol flags (`m.direct` or `is_direct`), it CANNOT be overridden by explicit configuration. Administrators have no escape hatch for misconfigured rooms.

**Why this matters:** Homeserver bugs or user errors can set DM flags on group rooms. Without an override, these rooms are stuck in DM mode regardless of configuration.

**Solution:** Move `resolveMatrixRoomConfig()` BEFORE the DM/group branching. If a room:

- Is classified as DM by protocol flags, AND
- Matches a non-wildcard config entry (`matchSource === "direct"`),
- Override `isDirectMessage` to `false`

Wildcard matches (`matchSource === "wildcard"`) must NOT trigger the override (would break DM routing with `"*"` catch-all configs).

### Constraints

**MUST NOT change:**

- DMs that are NOT explicitly configured must remain as DMs
- Wildcard config entries (`"*"`) must NOT override DM classification
- DMs must NEVER inherit group config settings (`skills`, `systemPrompt`, etc.)

**MUST change:**

- `resolveMatrixRoomConfig()` is called for ALL rooms (before DM/group branching)
- `const isDirectMessage` becomes `let isDirectMessage` to allow mutation

### Acceptance Criteria

**AC-2.1:** `resolveMatrixRoomConfig()` is called BEFORE the `isDirectMessage` check

**AC-2.2:** `resolveMatrixRoomConfig()` is called for ALL rooms (not just `isRoom`)

**AC-2.3:** `isDirectMessage` is declared with `let` instead of `const`

**AC-2.4:** After calling `isDirectMessage`, if:

- `isDirectMessage === true` AND
- `roomConfigInfo?.matchSource === "direct"`,
- Then: `isDirectMessage` is set to `false`

**AC-2.5:** If `roomConfigInfo?.matchSource === "wildcard"`, NO override occurs (DM stays DM)

**AC-2.6:** After override, `roomConfig` is set via:

```typescript
const roomConfig = isRoom ? roomConfigInfo?.config : undefined;
```

This ensures DMs never inherit group config even if they matched a config entry.

**AC-2.7:** Existing group room routing behavior is unchanged

### Affected Files

**Source:**

- `extensions/matrix/src/matrix/monitor/handler.ts`

**Tests:**

- `extensions/matrix/src/matrix/monitor/rooms.test.ts` (for `matchSource` classification)
- `extensions/matrix/src/matrix/monitor/handler.test.ts` (if integration tests exist)

**Note:** `handler.ts` has many dependencies (client, core, runtime, etc.) which makes unit testing difficult. If full integration tests are not feasible, focus on testing the `matchSource` classification in `rooms.test.ts` and document the handler behavior in this spec.

---

## F3: parentPeer for DM Room Binding (🟢 Minor)

### Intent

**Problem:** The `resolveAgentRoute()` call in `handler.ts` (around line 430-440) does not pass a `parentPeer` parameter for DM conversations. This prevents DM conversations from being bindable by room ID.

**Why this matters:** DM trust semantics should allow binding by room ID while preserving per-user isolation. Currently, DMs cannot be bound to specific room contexts.

**Solution:** Add `parentPeer` to the `resolveAgentRoute()` call:

```typescript
parentPeer: isDirectMessage ? { kind: "channel", id: roomId } : undefined;
```

### Constraints

**MUST NOT change:**

- Group room routing behavior
- DM trust semantics (sender-based isolation)

**MUST change:**

- `resolveAgentRoute()` call signature to include `parentPeer`

### Acceptance Criteria

**AC-3.1:** `resolveAgentRoute()` is called with:

```typescript
parentPeer: isDirectMessage ? { kind: "channel", id: roomId } : undefined;
```

**AC-3.2:** For DM messages, `parentPeer.kind === "channel"` and `parentPeer.id === roomId`

**AC-3.3:** For group messages, `parentPeer === undefined`

**AC-3.4:** Existing DM and group routing behavior is unchanged

### Affected Files

**Source:**

- `extensions/matrix/src/matrix/monitor/handler.ts`

**Tests:**

- `extensions/matrix/src/matrix/monitor/handler.test.ts` (if integration tests exist)

**Note:** This change is difficult to unit test in isolation due to `handler.ts` dependencies. Focus on behavioral verification in integration tests or document expected behavior in this spec.

---

## F4: Test Coverage (🟡 Notable)

### Intent

**Problem:** Only 3 tests exist for `direct.ts`. No coverage for:

- Fallback path (2 members + no name → DM)
- M_NOT_FOUND vs network error handling
- Priority ordering (m.direct > is_direct > fallback)
- Edge cases (3+ members, whitespace-only names)

No tests exist for `rooms.ts` `matchSource` classification.

**Why this matters:** Without comprehensive tests, the fallback logic and config override behavior cannot be verified. Future changes risk breaking DM detection.

**Solution:** Add comprehensive test suites covering all detection paths and edge cases.

### Constraints

**MUST NOT change:**

- The 3 existing tests in `direct.test.ts` MUST remain green
- Test behavior, NOT implementation details

**MUST add:**

- Tests for all fallback scenarios (new tests as `it.skip` for Red Phase)
- Tests for `matchSource` classification in `rooms.test.ts`
- Tests for config override behavior
- Tests for parentPeer routing

### Acceptance Criteria

**AC-4.1:** Existing tests in `direct.test.ts` remain green (no changes)

**AC-4.2:** New tests in `direct.test.ts` (all as `it.skip` for Red Phase):

**Fallback tests:**

- **AC-4.2.1:** 2 members + no room name (M_NOT_FOUND) → DM
- **AC-4.2.2:** 2 members + has room name (non-empty string) → group
- **AC-4.2.3:** 2 members + M_NOT_FOUND error on room name fetch → DM
- **AC-4.2.4:** 2 members + network error on room name fetch → group (conservative)
- **AC-4.2.5:** 3+ members (regardless of room name) → always group
- **AC-4.2.6:** 2 members + whitespace-only room name → DM (treated as "no name")

**Priority tests:**

- **AC-4.2.7:** m.direct === true → DM (regardless of is_direct or fallback)
- **AC-4.2.8:** is_direct === true → DM (regardless of fallback, when m.direct is false)
- **AC-4.2.9:** Both m.direct and is_direct false → fallback logic runs

**AC-4.3:** New tests in `rooms.test.ts`:

**matchSource classification:**

- **AC-4.3.1:** Direct room ID/alias match → `matchSource === "direct"`
- **AC-4.3.2:** Wildcard match (`"*"`) → `matchSource === "wildcard"`
- **AC-4.3.3:** No match → `matchSource === undefined`

**AC-4.4:** Config override tests (can be in `rooms.test.ts` or documented if handler.ts is too complex):

- **AC-4.4.1:** DM classified by protocol + `matchSource === "direct"` → override to group
- **AC-4.4.2:** DM classified by protocol + `matchSource === "wildcard"` → stays DM (NO override)
- **AC-4.4.3:** DM (after override to group) does NOT inherit group config (`skills`, `systemPrompt`)

**AC-4.5:** parentPeer tests (documented if handler.ts is too complex):

- **AC-4.5.1:** DM routes include `parentPeer: { kind: "channel", id: roomId }`
- **AC-4.5.2:** Group routes have `parentPeer: undefined`

**AC-4.6:** All new tests for fallback logic (F1) are written as `it.skip(...)` (Red Phase)

**AC-4.7:** Tests use vitest assertions (`expect`, `toBe`, `toHaveBeenCalled`, etc.)

**AC-4.8:** Tests mock MatrixClient methods appropriately (based on existing test patterns)

### Affected Files

**Tests:**

- `extensions/matrix/src/matrix/monitor/direct.test.ts` (extend)
- `extensions/matrix/src/matrix/monitor/rooms.test.ts` (extend)
- `extensions/matrix/src/matrix/monitor/handler.test.ts` (if feasible; otherwise document expected behavior)

---

## Implementation Notes

### Test Strategy

1. **direct.test.ts:** Add comprehensive fallback and priority tests
   - New tests as `it.skip(...)` since the implementation doesn't exist yet (Red Phase)
   - Existing tests MUST remain green

2. **rooms.test.ts:** Add `matchSource` classification tests
   - These can be written as non-skipped tests since `matchSource` logic already exists

3. **handler.ts:** Difficult to unit test due to many dependencies
   - Document expected behavior in this spec
   - If integration test infrastructure exists, add tests there
   - Otherwise, rely on manual verification + spec documentation

### Error Handling

- **isMatrixNotFoundError:** Must safely handle non-object errors (e.g., strings, nulls)
- **Room name fetch:** Must distinguish M_NOT_FOUND (expected) from network errors (ambiguous)
- **Conservative fallback:** When in doubt, classify as group (safer than false DM)

### Backward Compatibility

- Removing `includeMemberCountInLogs` is a breaking change for the API surface
- However, it was a default-false option with no known production usage
- The behavior change (always fetching member count) is acceptable for the fallback logic

---

## Summary

| Finding                   | Severity    | Files Changed                     | Test Strategy                                            |
| ------------------------- | ----------- | --------------------------------- | -------------------------------------------------------- |
| F1: Conservative fallback | 🔴 Critical | `direct.ts`                       | New tests in `direct.test.ts` (as `it.skip`)             |
| F2: Config override       | 🟡 Notable  | `handler.ts`                      | New tests in `rooms.test.ts` + document handler behavior |
| F3: parentPeer            | 🟢 Minor    | `handler.ts`                      | Document expected behavior (hard to unit test)           |
| F4: Test coverage         | 🟡 Notable  | `direct.test.ts`, `rooms.test.ts` | Comprehensive test suite                                 |

---

## Verification Plan

1. **Run existing tests:** `cd extensions/matrix && npx vitest run src/matrix/monitor/direct.test.ts src/matrix/monitor/rooms.test.ts`
   - All existing tests MUST be green
   - New skipped tests should show as "skipped" (not failed)

2. **Document skipped tests:** List all `it.skip` tests and explain why they're skipped (Red Phase - implementation pending)

3. **Verify test coverage:** Ensure all acceptance criteria have corresponding tests

4. **Commit strategy:**
   - Commit 1: Add SPEC.md
   - Commit 2: Add fallback tests to `direct.test.ts`
   - Commit 3: Add `matchSource` tests to `rooms.test.ts`
   - Commit 4: Document handler.ts behavior (if unit tests not feasible)

5. **Clean working tree:** No uncommitted changes before completion
