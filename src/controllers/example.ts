import { ProcessEngine } from '../models/engine';
import { ProcessDefinition, User } from '../models/types';

// ============================================================
// CAPA Process Definition (from assignment specification)
// ============================================================

const capaDefinition: ProcessDefinition = {
  id: 'capa-v1',
  name: 'CAPA Process',
  version: 1,
  steps: [
    {
      stepKey: 'initiation',
      name: '1. Initiation',
      order: 1,
      type: 'task',
      assigneeRule: { type: 'any_user' },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'description', type: 'text', required: true },
        { name: 'severity', type: 'enum', required: true, validation: { enumValues: ['Critical', 'Major', 'Minor'] } },
      ],
      crossFieldRules: [],
    },
    {
      stepKey: 'investigation',
      name: '2. Investigation',
      order: 2,
      type: 'task',
      assigneeRule: { type: 'role', value: 'engineer' },
      fields: [
        { name: 'root_cause_analysis', type: 'text', required: false },
        { name: 'findings', type: 'text', required: true },
      ],
      crossFieldRules: [
        {
          if: { field: 'severity', op: 'eq', value: 'Critical' },
          then: { field: 'root_cause_analysis', required: true },
          errorMessage: 'Root cause analysis is required when severity is Critical',
        },
      ],
      escalation: {
        timeoutHours: 48,
        escalateTo: { type: 'role', value: 'qa_manager' },
        condition: { field: 'severity', op: 'eq', value: 'Critical' },
      },
    },
    {
      stepKey: 'review',
      name: '3. Review',
      order: 3,
      type: 'parallel_approval',
      assigneeRule: { type: 'specific_users', userIds: ['qa-mgr-1', 'dept-head-1'] },
      fields: [],
      crossFieldRules: [],
      requiredApprovers: ['qa-mgr-1', 'dept-head-1'],
    },
    {
      stepKey: 'implementation',
      name: '4. Implementation',
      order: 4,
      type: 'checklist',
      assigneeRule: { type: 'role', value: 'engineer' },
      fields: [],
      crossFieldRules: [],
      checklistItems: [
        'Corrective action implemented',
        'Documentation updated',
        'Training completed',
        'Verification test passed',
      ],
    },
    {
      stepKey: 'effectiveness_check',
      name: '5. Effectiveness Check',
      order: 5,
      type: 'approval',
      assigneeRule: { type: 'role', value: 'qa_manager' },
      fields: [
        { name: 'is_effective', type: 'boolean', required: true },
      ],
      crossFieldRules: [],
    },
  ],
  transitions: [
    { fromStepKey: 'initiation', toStepKey: 'investigation', action: 'complete', priority: 0 },
    { fromStepKey: 'investigation', toStepKey: 'review', action: 'complete', priority: 0 },
    { fromStepKey: 'review', toStepKey: 'implementation', action: 'approve', priority: 0 },
    { fromStepKey: 'review', toStepKey: 'investigation', action: 'reject', priority: 0 },
    { fromStepKey: 'implementation', toStepKey: 'effectiveness_check', action: 'complete', priority: 0 },
    { fromStepKey: 'effectiveness_check', toStepKey: 'investigation', action: 'reopen',
      condition: { field: 'is_effective', op: 'eq', value: false }, priority: 1 },
    // Self-loop: engine treats completed → same stepKey as terminal and completes the process.
    { fromStepKey: 'effectiveness_check', toStepKey: 'effectiveness_check', action: 'approve', priority: 0 },
  ],
};

// ============================================================
// Test Users
// ============================================================

const users: Record<string, User> = {
  alice: { id: 'alice-1', name: 'Alice (Initiator)', roles: ['operator'] },
  bob: { id: 'bob-1', name: 'Bob (Engineer)', roles: ['engineer'] },
  qaManager: { id: 'qa-mgr-1', name: 'QA Manager', roles: ['qa_manager'] },
  deptHead: { id: 'dept-head-1', name: 'Dept Head', roles: ['dept_head'] },
};

// ============================================================
// Run the example
// ============================================================

function runCAPAExample() {
  const engine = new ProcessEngine();

  // 1. Load definition
  engine.loadDefinition(capaDefinition);
  console.log('✓ CAPA definition loaded\n');

  // 2. Start process — Initiation
  const instance = engine.startProcess('capa-v1', users.alice, {
    title: 'Defective Batch #4521',
    description: 'Batch failed viscosity test at station 3',
    severity: 'Critical',
  });
  console.log(`✓ Process started: ${instance.id}`);
  console.log(`  Current step: ${instance.currentStepKey}\n`);

  // 3. Complete Initiation → moves to Investigation
  const r1 = engine.advanceStep(instance.id, 'initiation', { type: 'complete' }, users.alice);
  console.log(`✓ Initiation completed → next: ${r1.nextStepKey}\n`);

  // 4. Investigation — try without root_cause_analysis (should fail for Critical)
  try {
    engine.advanceStep(instance.id, 'investigation', {
      type: 'complete',
      fields: { findings: 'Viscosity out of spec' },
    }, users.bob);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`✗ Expected error: ${msg}\n`);
  }

  // 5. Investigation — now with root_cause_analysis
  const r2 = engine.advanceStep(instance.id, 'investigation', {
    type: 'complete',
    fields: {
      findings: 'Viscosity out of spec due to temperature drift',
      root_cause_analysis: 'Thermocouple on reactor 3 failed, causing temperature overshoot',
    },
  }, users.bob);
  console.log(`✓ Investigation completed → next: ${r2.nextStepKey}\n`);

  // 6. Parallel Approval — QA Manager approves
  const r3 = engine.advanceStep(instance.id, 'review', {
    type: 'approve', comments: 'Investigation is thorough',
  }, users.qaManager);
  console.log(`✓ QA Manager approved. Waiting on: ${r3.waitingOn?.join(', ')}\n`);

  // 7. Parallel Approval — Dept Head approves → advances
  const r4 = engine.advanceStep(instance.id, 'review', {
    type: 'approve', comments: 'Agreed, proceed with implementation',
  }, users.deptHead);
  console.log(`✓ Dept Head approved → next: ${r4.nextStepKey}\n`);

  // 8. Checklist — mark all items, then complete
  for (let i = 0; i < 4; i++) {
    engine.markChecklistItem(instance.id, 'implementation', i, users.bob);
  }
  console.log('✓ All checklist items marked');

  const r5 = engine.advanceStep(instance.id, 'implementation', { type: 'complete' }, users.bob);
  console.log(`✓ Implementation completed → next: ${r5.nextStepKey}\n`);

  // 9. Effectiveness Check — approve as effective
  const r6 = engine.advanceStep(instance.id, 'effectiveness_check', {
    type: 'approve',
    fields: { is_effective: true },
  }, users.qaManager);
  console.log(`✓ Effectiveness check approved\n`);

  // 10. Print audit trail
  const audit = engine.getAuditTrail(instance.id);
  console.log(`\n═══ AUDIT TRAIL (${audit.length} entries) ═══\n`);
  for (const entry of audit) {
    console.log(`  [${entry.timestamp.toISOString()}] ${entry.action.padEnd(25)} | step: ${(entry.stepKey || '-').padEnd(22)} | ${entry.previousState || '-'} → ${entry.newState || '-'} | actor: ${entry.actorId}`);
  }

  // 11. Verify audit integrity
  const integrity = engine.verifyAuditIntegrity(instance.id);
  console.log(`\n✓ Audit integrity check: ${integrity.valid ? 'PASSED' : 'FAILED'}`);

  // 12. Final instance state
  const final = engine.getInstance(instance.id)!;
  console.log(`✓ Process status: ${final.status}`);
}

runCAPAExample();
