# Commit 2 — Review notes (PR review follow-up)

This file satisfies the assignment’s **`docs/review-notes.md`** requirement. It records what was wrong in the initial (Commit 1–style) implementation, **what** was fixed, and **why**.

---

## Summary

| Issue (original) | Severity | Resolution |
|------------------|----------|------------|
| Line count exceeds ~300 | MAJOR | Split `engine.ts` into focused modules; core `ProcessEngine` kept under ~300 lines. |
| No concurrency protection | MAJOR | Per-instance synchronous lock (`InstanceLockManager`); class-level note for multi-node use. |
| Raw string errors | MEDIUM | Typed error hierarchy with stable `code` values (`errors.ts`). |
| `Record<string, any>` | MEDIUM | `FieldValue`, `FieldBag`, stricter audit field typing, `unknown` for open metadata. |
| Effectiveness self-transition | MINOR | Completed step with transition to same `stepKey` completes the process instead of re-activating the step. |

Additional work after the review:

- **MVC-style layout**: domain under `src/models/`, demo orchestration under `src/controllers/`, `src/views/` reserved for future presentation.
- **Tooling**: `package.json` scripts run the CAPA demo via `tsx`.

---

## MAJOR — Line count (~300 lines)

**Before:** A single large `engine.ts` (~378 lines) held transitions, validation, parallel approval, checklist handling, and audit hashing.

**After:**

- `src/models/engine.ts` — `ProcessEngine` orchestration only (target: stay near or under ~300 lines).
- `src/models/field-ops.ts` — `findTransition`, `evaluateCondition`, `validateFields`.
- `src/models/step-handlers.ts` — parallel approval and checklist step flows.
- `src/models/audit-chain.ts` — append + verify for the hash-chained audit log.

This keeps the main engine file readable and aligns with the “trim / extract helpers” guidance without changing behavior.

---

## MAJOR — Concurrency

**Risk:** Two overlapping mutators on the same process instance could corrupt `approvals`, `fields`, or step state (especially parallel approval).

**Change:**

- `src/models/instance-lock.ts` — `InstanceLockManager.runExclusive(instanceId, fn)` wraps mutating entry points.
- `advanceStep` and `markChecklistItem` run inside this lock; a nested concurrent call on the same `instanceId` throws `ConcurrencyError`.
- JSDoc on `ProcessEngine` states that this is **in-process** serialization; distributed or multi-process deployments still need an external lock or single writer.

---

## MEDIUM — Typed errors

**Before:** Widespread `throw new Error('...')` made it hard to branch on validation vs authorization vs not-found without parsing messages.

**After:** `src/models/errors.ts` defines:

- `EngineError` base with `code`
- `ValidationError`, `AuthorizationError`, `TransitionError`, `ConcurrencyError`
- `NotFoundError`, `DefinitionError`, `StateError` with specific `code` variants

Call sites were updated to throw these types instead of generic `Error`.

---

## MEDIUM — Replacing `Record<string, any>`

**Changes in `src/models/types.ts` (and usage):**

- `FieldValue` — `string | number | boolean | null`
- `FieldBag` — `Record<string, FieldValue>` for instance and action payloads
- Condition values on rules use `FieldValue` where applicable
- `AuditFieldChanges` — union of field snapshots and `{ before, after }` shapes
- `AuditEntry.metadata` — `Record<string, unknown> | null`

---

## MINOR — Effectiveness check “self” transition

**Before:** A transition `effectiveness_check → effectiveness_check` on `approve` caused `activateNextStep` to treat the next step as existing and **re-open** the same step, so the process did not reliably complete.

**After:** If `nextStepKey === fromStepKey` and the step finished with `newStatus === 'completed'`, the engine marks the **process** completed and emits `process_completed` audit, matching the CAPA example’s intent.

The CAPA definition comment in `src/controllers/example.ts` was updated to describe this behavior.

---

## Project layout (MVC-oriented)

| Area | Path | Role |
|------|------|------|
| Model | `src/models/` | Types, engine, validation, step handlers, audit chain, locks, errors |
| Controller | `src/controllers/example.ts` | Demo: loads definition, drives `ProcessEngine`, prints to console |
| View | `src/views/` | Placeholder for future UI / formatters (currently `.gitkeep` only) |

---

## Optional follow-ups (not done in this pass)

- Async API + promise-based mutex if mutations become asynchronous.
- Split console output from `example.ts` into `src/views/` for stricter MVC.
- Terminal step key convention (e.g. explicit sentinel) instead of self-loop semantics, if definitions should stay free of “magic” same-key transitions.
