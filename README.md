# Unifize — Principal Engineer Assignment

Submission for **Designing a Configurable Process Engine** (Principal Engineer Assignment). The original brief PDF is in the repo:

- [`docs/Unifize Principal Engineer Assignment.pdf`](docs/Unifize%20Principal%20Engineer%20Assignment.pdf)

This README maps **each part of the assignment** to **where it lives in the repository**, documents **how the solution is organized**, and explains **documentation choices** relative to the submission template.

---

## How documentation is organized (and why)

The assignment suggests a flat `process-engine/` tree with specific doc filenames. This repo uses the **same content and intent**, organized as **reasoned markdown docs** under **`docs/`** plus a root **`README.md`**:

| Assignment asked for | In this repo | Reason |
|----------------------|--------------|--------|
| Part 1 design in README | **[`docs/architecture.md`](docs/architecture.md)** + summary pointers here | Keeps **README** scannable; Part 1 is long (schema, indexes, diagrams). One place for “system design” reviewers expect to open. |
| `docs/review-notes.md` | **[`docs/review-notes.md`](docs/review-notes.md)** | Matches the spec. **[`Review.md`](Review.md)** at the root is a **stub** that points here so older links still work. |
| `docs/evolution.md` | **[`docs/evolution.md`](docs/evolution.md)** | Part 3 scenarios A–C in one design doc. |
| `docs/architecture.(png\|pdf\|md)` | **`docs/architecture.md`** (Mermaid) | No binary diagram export required; Mermaid renders in GitHub/GitLab and stays diff-friendly. |

Nothing substantive is “missing”—it is **split for clarity** (design vs runbook vs review) instead of duplicating large blocks only in `README.md`.

---

## Assignment map — where to find each requirement

### Domain primer & constraints (context only)

| Topic | Where addressed |
|-------|-----------------|
| eQMS / CAPA / audit immutability (conceptual) | [`docs/architecture.md`](docs/architecture.md) §3 Audit trail; [`docs/evolution.md`](docs/evolution.md) Scenario C |
| Every state change: actor, timestamp, previous/new state | [`src/models/types.ts`](src/models/types.ts) `AuditEntry`; append sites in [`src/models/engine.ts`](src/models/engine.ts), [`src/models/step-handlers.ts`](src/models/step-handlers.ts) |
| Append-only / tamper evidence | [`src/models/audit-chain.ts`](src/models/audit-chain.ts); `verifyAuditIntegrity` in [`src/models/engine.ts`](src/models/engine.ts) |
| Multiple instances concurrently | In-memory `Map` per instance in engine; **per-instance lock** in [`src/models/instance-lock.ts`](src/models/instance-lock.ts) (same Node process). Design for multi-node in [`docs/architecture.md`](docs/architecture.md) + [`docs/review-notes.md`](docs/review-notes.md) |

### Supported features → code

| Feature | Location |
|---------|----------|
| Step types (task, approval, parallel approval, checklist, …) | [`src/models/types.ts`](src/models/types.ts) `StepType`; handling in [`src/models/engine.ts`](src/models/engine.ts), [`src/models/step-handlers.ts`](src/models/step-handlers.ts) |
| Conditional routing | [`src/models/field-ops.ts`](src/models/field-ops.ts) `findTransition` + conditions on `TransitionRule` |
| Parallel approvals (all must approve) | [`src/models/step-handlers.ts`](src/models/step-handlers.ts) `handleParallelApproval` |
| Escalation rules (e.g. 48h) | **Metadata** on step in CAPA example [`src/controllers/example.ts`](src/controllers/example.ts); **execution** would be a scheduler (described in [`docs/architecture.md`](docs/architecture.md)) |
| Field validations (required, pattern, enum, cross-field) | [`src/models/field-ops.ts`](src/models/field-ops.ts) `validateFields`; rules in types [`src/models/types.ts`](src/models/types.ts) |
| Example CAPA definition (all 5 steps) | [`src/controllers/example.ts`](src/controllers/example.ts) `capaDefinition` |

---

### Part 1: Data modeling & system design (~75 min)

| # | Requirement | Location |
|---|-------------|----------|
| 1 | Data model (Postgres schema / ER / ORM) | [`docs/architecture.md`](docs/architecture.md) §1 `CREATE TABLE`, definition vs instance |
| 1 | Indexing strategy + rationale | [`docs/architecture.md`](docs/architecture.md) §1 table “Indexing strategy” |
| 1 | Definition vs running instance | [`docs/architecture.md`](docs/architecture.md) §1 “Definition vs instance” + code types in [`src/models/types.ts`](src/models/types.ts) |
| 2 | State machine: transitions (2–3 examples) | [`docs/architecture.md`](docs/architecture.md) §2 + literal CAPA transitions in [`src/controllers/example.ts`](src/controllers/example.ts) |
| 2 | Invalid transition enforcement | [`docs/architecture.md`](docs/architecture.md) §2; code: [`src/models/engine.ts`](src/models/engine.ts), [`src/models/field-ops.ts`](src/models/field-ops.ts), [`src/models/errors.ts`](src/models/errors.ts) |
| 2 | Parallel approval — when engine advances | [`docs/architecture.md`](docs/architecture.md) §2; [`src/models/step-handlers.ts`](src/models/step-handlers.ts) |
| 3 | Audit: what is logged, entry schema | [`docs/architecture.md`](docs/architecture.md) §3; [`src/models/types.ts`](src/models/types.ts) `AuditEntry` |
| 3 | Immutability approach | [`docs/architecture.md`](docs/architecture.md) §3; in-code append-only + `getAuditTrail` copy |
| 3 | Proof to auditor (tamper) | [`docs/architecture.md`](docs/architecture.md) §3; [`src/models/audit-chain.ts`](src/models/audit-chain.ts) |
| 4 | Architecture diagram | [`docs/architecture.md`](docs/architecture.md) §4 Mermaid |
| 4 | Data flow (approve → transition → audit) | [`docs/architecture.md`](docs/architecture.md) §4 narrative under diagram |

---

### Part 2: Implementation (~90 min)

| # | Requirement | Location |
|---|-------------|----------|
| — | Core domain logic, in-memory | [`src/models/`](src/models/) |
| — | `LoadDefinition` / `StartProcess` / `AdvanceStep` / `GetAuditTrail` | [`src/models/engine.ts`](src/models/engine.ts) `loadDefinition`, `startProcess`, `advanceStep`, `getAuditTrail` (Go-style interface expressed as a **class** in TypeScript; sync APIs throw instead of `(T, error)`) |
| — | Field validation before transition | [`src/models/field-ops.ts`](src/models/field-ops.ts); calls from [`src/models/engine.ts`](src/models/engine.ts) |
| — | Transition rules + parallel + conditional | [`src/models/field-ops.ts`](src/models/field-ops.ts), [`src/models/step-handlers.ts`](src/models/step-handlers.ts), [`src/models/engine.ts`](src/models/engine.ts) |
| — | Audit every action (actor, time, states, reason) | [`src/models/engine.ts`](src/models/engine.ts) `appendAudit`; chain in [`src/models/audit-chain.ts`](src/models/audit-chain.ts) |
| — | Clear errors on invalid transition | [`src/models/errors.ts`](src/models/errors.ts) |
| — | Commit 1 vs Commit 2 / review narrative | [`docs/review-notes.md`](docs/review-notes.md) |
| — | ~300 lines judgment | Split modules; main engine file ~266 lines — see [`docs/review-notes.md`](docs/review-notes.md) |

**Runnable demo:** [`src/controllers/example.ts`](src/controllers/example.ts) (CAPA walkthrough + audit print + integrity check).

---

### Part 3: System evolution (~30 min)

| Scenario | Location |
|----------|----------|
| A Versioning | [`docs/evolution.md`](docs/evolution.md) Scenario A |
| B Cross-process dependencies | [`docs/evolution.md`](docs/evolution.md) Scenario B |
| C Audit at scale | [`docs/evolution.md`](docs/evolution.md) Scenario C |

---

### Submission structure (assignment template)

| Expected path | This repo |
|---------------|-----------|
| `README.md` | **This file** (overview + **assignment map** + doc rationale) |
| `docs/architecture.*` | [`docs/architecture.md`](docs/architecture.md) |
| `docs/review-notes.md` | [`docs/review-notes.md`](docs/review-notes.md) |
| `docs/evolution.md` | [`docs/evolution.md`](docs/evolution.md) |
| `src/…` | [`src/models/`](src/models/), [`src/controllers/example.ts`](src/controllers/example.ts), [`src/views/`](src/views/) |

---

## Requirements

- **Node.js** 18+
- **npm**

## Quick start

```bash
npm install
npm start
```

Runs `tsx src/controllers/example.ts` (CAPA scenario, audit trail, integrity check).

## Project layout (MVC-oriented)

| Layer | Path |
|-------|------|
| Model | [`src/models/`](src/models/) |
| Controller | [`src/controllers/example.ts`](src/controllers/example.ts) |
| View | [`src/views/`](src/views/) (placeholder for future UI) |

## Scripts

| Script | Command |
|--------|---------|
| `npm start` / `npm run example` | CAPA demo |

## Tech stack

TypeScript, `tsx`, `node:crypto` for audit hashing, `@types/node`.

## License

Not specified in this repository by default.
