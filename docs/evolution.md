# Part 3 — System evolution (design only)

The assignment asks for **short design answers** to three post-launch scenarios. Nothing here is implemented in code; it extends the model and architecture described in [`architecture.md`](architecture.md).

---

## Scenario A: Process versioning

**Requirement:** Customers edit definitions; **in-flight** instances must keep the definition version they started on; **new** instances use the latest version.

### Data model changes

- **`process_definition`**: Add `version` (int), `definition_key` (customer-stable id), and **`published_at`**. Treat each publish as an **immutable row** (insert-only new version) rather than updating rows in place.
- **`process_instance`**: Store **`definition_id`** (FK to the exact published row the instance was created from), not only `definition_key`. Optionally store `definition_version` denormalized for reporting.
- **Transitions / steps**: Remain children of a specific `definition_id`, never shared across versions.

### Migration risks

- **Long-running instances** on old versions: operational burden (support N versions of validation/routing logic if behavior must match old semantics exactly). Mitigation: keep **versioned executor** or compile definition to a frozen “plan” snapshot at start.
- **Bug fixes** on old versions: regulators may expect patches; you may need **hotfix versions** (e.g. v3.1) still tied to the same logical “generation” of instances.
- **Schema drift** if definitions embed field keys that instances already collected: adding required fields mid-flight is unsafe; versioning rules should forbid incompatible edits or require **migration playbooks** per version bump.

---

## Scenario B: Cross-process dependencies

**Requirement:** e.g. Document Review cannot complete until a linked CAPA reaches **Implementation**.

### Modeling the dependency

- New table **`process_dependency`**: `blocking_instance_id`, `blocked_instance_id`, `rule_type` (e.g. `step_reached`), `required_step_key`, `status` (`pending` | `satisfied` | `released`).
- Alternatively, **`process_link`** with a declarative condition evaluated by a small **dependency service** that subscribes to step transitions (event-driven).

**Engine integration:** Before allowing a transition that would **complete** the blocked process (or specific step), check dependencies; if unsatisfied, return a typed error or queue the action.

### Preventing circular dependencies

- On link creation, run **cycle detection** (graph of instance IDs or definition-level templates if dependencies are templated).
- For definition-level templates, validate **acyclic** graphs at publish time; for runtime instance links, reject edges that would close a cycle.

### Blocking process cancelled

- Define policy explicitly: **`released`** (unblock with audit reason), **`failed`** (blocked process errors), or **manual resolution**. Log dependency state changes in the audit trail of **both** processes (or a dedicated compliance log) so auditors see why unblock happened.

---

## Scenario C: Audit trail at scale (500M+ rows)

**Symptom:** `(instance_id, timestamp)` is fast for single-instance timelines; **global date-range** compliance scans time out.

### Partitioning / archival

- **Partition** `audit_log` by **time** (monthly/quarterly) using `timestamp` (and optionally `tenant_id` first for multi-tenant). Keeps recent partitions hot and prunes/archives old ones under retention policy.
- **Archive** cold partitions to **object storage** (Parquet/ORC) with **immutable** WORM buckets; keep an **index** of archive locations for legal hold queries.
- **Secondary index** or **OLAP replica** (columnar warehouse) for “all events in [date] across tenants” reports, fed by CDC — avoid scanning the OLTP primary.

### Trade-offs

- Time partitioning can scatter one instance across partitions (acceptable if queries are usually by instance + time range with partition pruning, or if you add **instance_id hash sub-partitioning** with care).
- Warehouses add **eventual consistency** and duplicate storage cost.
- Archival complicates **tamper-evidence** if verification must span tiers; carry **hash chain checkpoints** per partition and sign exports.

### Storage layer change?

- **Yes, for compliance analytics:** Keep **append-only OLTP** Postgres (or similar) for real-time writes and per-instance reads; use **BigQuery / Snowflake / ClickHouse** (or Postgres **Citus** / **Timescale** hypertables) for heavy scans, with clear **SLA** that reports lag primary by minutes acceptable or not.

---

## Summary

| Scenario | Core idea |
|----------|-----------|
| A | Immutable definition versions; instance pins `definition_id`; insert-only publishes. |
| B | Explicit dependency graph + cycle checks + audited unblock policies. |
| C | Time (and tenant) partitioning + columnar/warehouse for cross-instance reports + archival with integrity metadata. |
