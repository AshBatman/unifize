import { createHash } from 'crypto';
import {
  ProcessDefinition, ProcessInstance, StepInstance, StepDefinition,
  Action, StepResult, AuditEntry, User, TransitionRule,
  StepStatus, ActionType, FieldDefinition, CrossFieldRule,
} from './types';

export class ProcessEngine {
  private definitions = new Map<string, ProcessDefinition>();
  private instances = new Map<string, ProcessInstance>();
  private auditLogs = new Map<string, AuditEntry[]>();
  private auditCounter = 0;

  // ── Definition Management ──────────────────────────────────

  loadDefinition(def: ProcessDefinition): void {
    if (!def.id || !def.steps.length) {
      throw new Error('Definition must have an ID and at least one step');
    }
    if (this.definitions.has(def.id)) {
      throw new Error(`Definition ${def.id} already loaded`);
    }
    // Validate all transition rules reference valid step keys
    const stepKeys = new Set(def.steps.map(s => s.stepKey));
    for (const t of def.transitions) {
      if (!stepKeys.has(t.fromStepKey) || !stepKeys.has(t.toStepKey)) {
        throw new Error(`Transition references unknown step: ${t.fromStepKey} → ${t.toStepKey}`);
      }
    }
    this.definitions.set(def.id, def);
  }

  // ── Process Lifecycle ──────────────────────────────────────

  startProcess(definitionId: string, initiator: User, fields: Record<string, any>): ProcessInstance {
    const def = this.definitions.get(definitionId);
    if (!def) throw new Error(`Definition ${definitionId} not found`);

    const firstStep = def.steps.sort((a, b) => a.order - b.order)[0];

    // Validate initial fields against first step's field definitions
    this.validateFields(firstStep, fields, fields);

    const instanceId = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    const stepInstances = new Map<string, StepInstance>();
    for (const stepDef of def.steps) {
      stepInstances.set(stepDef.stepKey, {
        instanceId,
        stepKey: stepDef.stepKey,
        status: stepDef.stepKey === firstStep.stepKey ? 'in_progress' : 'pending',
        fields: stepDef.stepKey === firstStep.stepKey ? { ...fields } : {},
        approvals: [],
        checklistItems: (stepDef.checklistItems || []).map(text => ({
          text, completed: false,
        })),
        startedAt: stepDef.stepKey === firstStep.stepKey ? now : undefined,
      });
    }

    const instance: ProcessInstance = {
      id: instanceId,
      definitionId,
      status: 'active',
      initiatedBy: initiator.id,
      fields: { ...fields },
      currentStepKey: firstStep.stepKey,
      steps: stepInstances,
      createdAt: now,
      updatedAt: now,
    };

    this.instances.set(instanceId, instance);
    this.auditLogs.set(instanceId, []);

    this.appendAudit(instanceId, null, initiator.id, 'process_started', null, 'active', fields, null);
    this.appendAudit(instanceId, firstStep.stepKey, initiator.id, 'step_activated', 'pending', 'in_progress', null, null);

    return instance;
  }

  // ── State Transitions ──────────────────────────────────────

  advanceStep(instanceId: string, stepKey: string, action: Action, actor: User): StepResult {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} not found`);
    if (instance.status !== 'active') throw new Error(`Instance is ${instance.status}, not active`);

    const def = this.definitions.get(instance.definitionId)!;
    const stepDef = def.steps.find(s => s.stepKey === stepKey);
    if (!stepDef) throw new Error(`Step ${stepKey} not found in definition`);

    const stepInst = instance.steps.get(stepKey)!;
    if (stepInst.status !== 'in_progress') {
      throw new Error(`Step ${stepKey} is ${stepInst.status}, cannot advance`);
    }

    // Verify actor is authorized
    this.checkAuthorization(stepDef, actor);

    // Merge any submitted fields
    if (action.fields) {
      Object.assign(stepInst.fields, action.fields);
      Object.assign(instance.fields, action.fields);
    }

    // Handle based on step type
    if (stepDef.type === 'parallel_approval') {
      return this.handleParallelApproval(instance, stepDef, stepInst, action, actor, def);
    }

    if (stepDef.type === 'checklist' && action.type === 'complete') {
      return this.handleChecklist(instance, stepDef, stepInst, action, actor, def);
    }

    // Standard step transition
    if (action.type === 'complete' || action.type === 'approve') {
      this.validateFields(stepDef, stepInst.fields, instance.fields);
    }

    const transition = this.findTransition(def, stepKey, action.type, instance.fields);
    if (!transition) {
      throw new Error(`No valid transition from step ${stepKey} with action ${action.type}`);
    }

    const previousStatus = stepInst.status;
    const newStatus: StepStatus = action.type === 'reject' ? 'rejected' : 'completed';

    stepInst.status = newStatus;
    stepInst.completedAt = new Date();

    this.appendAudit(instanceId, stepKey, actor.id, action.type, previousStatus, newStatus,
      action.fields || null, action.comments || null);

    return this.activateNextStep(instance, transition.toStepKey, actor, previousStatus, newStatus, stepKey);
  }

  // ── Parallel Approval ──────────────────────────────────────

  private handleParallelApproval(
    instance: ProcessInstance, stepDef: StepDefinition, stepInst: StepInstance,
    action: Action, actor: User, def: ProcessDefinition
  ): StepResult {
    if (action.type !== 'approve' && action.type !== 'reject') {
      throw new Error(`Parallel approval step only accepts approve/reject, got ${action.type}`);
    }

    // Initialize approvals if first time
    if (stepInst.approvals.length === 0 && stepDef.requiredApprovers) {
      stepInst.approvals = stepDef.requiredApprovers.map(id => ({
        approverId: id, decision: 'pending',
      }));
    }

    const approval = stepInst.approvals.find(a => a.approverId === actor.id);
    if (!approval) throw new Error(`User ${actor.id} is not a required approver for step ${stepInst.stepKey}`);
    if (approval.decision !== 'pending') throw new Error(`User ${actor.id} has already decided: ${approval.decision}`);

    approval.decision = action.type === 'approve' ? 'approved' : 'rejected';
    approval.comments = action.comments;
    approval.decidedAt = new Date();

    this.appendAudit(instance.id, stepInst.stepKey, actor.id, action.type, 'in_progress', 'in_progress',
      null, action.comments || null);

    // Check if any rejection → immediately reject the step
    const hasRejection = stepInst.approvals.some(a => a.decision === 'rejected');
    if (hasRejection) {
      stepInst.status = 'rejected';
      stepInst.completedAt = new Date();
      const transition = this.findTransition(def, stepInst.stepKey, 'reject', instance.fields);
      if (!transition) throw new Error(`No rejection transition defined for step ${stepInst.stepKey}`);
      this.appendAudit(instance.id, stepInst.stepKey, 'system', 'step_rejected', 'in_progress', 'rejected', null, null);
      return this.activateNextStep(instance, transition.toStepKey, actor, 'in_progress', 'rejected', stepInst.stepKey);
    }

    // Check if all approved → complete the step
    const allApproved = stepInst.approvals.every(a => a.decision === 'approved');
    if (allApproved) {
      stepInst.status = 'completed';
      stepInst.completedAt = new Date();
      const transition = this.findTransition(def, stepInst.stepKey, 'approve', instance.fields);
      if (!transition) throw new Error(`No approval transition defined for step ${stepInst.stepKey}`);
      this.appendAudit(instance.id, stepInst.stepKey, 'system', 'step_completed', 'in_progress', 'completed', null, null);
      return this.activateNextStep(instance, transition.toStepKey, actor, 'in_progress', 'completed', stepInst.stepKey);
    }

    // Still waiting on others
    const waitingOn = stepInst.approvals.filter(a => a.decision === 'pending').map(a => a.approverId);
    return {
      success: true, instanceId: instance.id, stepKey: stepInst.stepKey,
      previousStatus: 'in_progress', newStatus: 'in_progress', waitingOn,
    };
  }

  // ── Checklist Handling ─────────────────────────────────────

  private handleChecklist(
    instance: ProcessInstance, stepDef: StepDefinition, stepInst: StepInstance,
    action: Action, actor: User, def: ProcessDefinition
  ): StepResult {
    const allDone = stepInst.checklistItems.every(item => item.completed);
    if (!allDone) {
      throw new Error('All checklist items must be completed before advancing');
    }
    this.validateFields(stepDef, stepInst.fields, instance.fields);
    const transition = this.findTransition(def, stepInst.stepKey, 'complete', instance.fields);
    if (!transition) throw new Error(`No transition from checklist step ${stepInst.stepKey}`);

    stepInst.status = 'completed';
    stepInst.completedAt = new Date();
    this.appendAudit(instance.id, stepInst.stepKey, actor.id, 'complete', 'in_progress', 'completed', null, null);
    return this.activateNextStep(instance, transition.toStepKey, actor, 'in_progress', 'completed', stepInst.stepKey);
  }

  markChecklistItem(instanceId: string, stepKey: string, itemIndex: number, actor: User): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} not found`);
    const stepInst = instance.steps.get(stepKey)!;
    if (stepInst.status !== 'in_progress') throw new Error(`Step ${stepKey} is not in progress`);
    if (itemIndex < 0 || itemIndex >= stepInst.checklistItems.length) throw new Error('Invalid checklist item index');

    const item = stepInst.checklistItems[itemIndex];
    item.completed = true;
    item.completedBy = actor.id;
    item.completedAt = new Date();
    this.appendAudit(instanceId, stepKey, actor.id, 'checklist_item_completed', null, null,
      { [item.text]: { before: false, after: true } }, null);
  }

  // ── Shared Helpers ─────────────────────────────────────────

  private activateNextStep(
    instance: ProcessInstance, nextStepKey: string, actor: User,
    previousStatus: StepStatus, newStatus: StepStatus, fromStepKey: string
  ): StepResult {
    const nextStep = instance.steps.get(nextStepKey);
    if (!nextStep) {
      // No next step — process is complete
      instance.status = 'completed';
      instance.updatedAt = new Date();
      this.appendAudit(instance.id, null, 'system', 'process_completed', 'active', 'completed', null, null);
      return { success: true, instanceId: instance.id, stepKey: fromStepKey, previousStatus, newStatus };
    }

    // Reset step if it's being revisited (e.g., rejection routing back)
    nextStep.status = 'in_progress';
    nextStep.startedAt = new Date();
    nextStep.completedAt = undefined;
    nextStep.approvals = nextStep.approvals.map(a => ({ ...a, decision: 'pending' as const, decidedAt: undefined }));
    instance.currentStepKey = nextStepKey;
    instance.updatedAt = new Date();

    this.appendAudit(instance.id, nextStepKey, 'system', 'step_activated', 'pending', 'in_progress', null, null);

    return {
      success: true, instanceId: instance.id, stepKey: fromStepKey,
      previousStatus, newStatus, nextStepKey,
    };
  }

  private findTransition(def: ProcessDefinition, fromStepKey: string, action: ActionType, fields: Record<string, any>): TransitionRule | null {
    const candidates = def.transitions
      .filter(t => t.fromStepKey === fromStepKey && t.action === action)
      .sort((a, b) => b.priority - a.priority);

    for (const t of candidates) {
      if (!t.condition || this.evaluateCondition(t.condition, fields)) return t;
    }
    return null;
  }

  private evaluateCondition(condition: { field: string; op: string; value: any }, fields: Record<string, any>): boolean {
    const fieldValue = fields[condition.field];
    switch (condition.op) {
      case 'eq': return fieldValue === condition.value;
      case 'neq': return fieldValue !== condition.value;
      case 'gt': return fieldValue > condition.value;
      case 'lt': return fieldValue < condition.value;
      default: return false;
    }
  }

  private validateFields(stepDef: StepDefinition, stepFields: Record<string, any>, instanceFields: Record<string, any>): void {
    for (const fieldDef of stepDef.fields) {
      const value = stepFields[fieldDef.name];
      if (fieldDef.required && (value === undefined || value === null || value === '')) {
        throw new Error(`Field '${fieldDef.name}' is required in step '${stepDef.name}'`);
      }
      if (value && fieldDef.validation?.pattern) {
        if (!new RegExp(fieldDef.validation.pattern).test(String(value))) {
          throw new Error(`Field '${fieldDef.name}' does not match pattern ${fieldDef.validation.pattern}`);
        }
      }
      if (value && fieldDef.validation?.enumValues) {
        if (!fieldDef.validation.enumValues.includes(String(value))) {
          throw new Error(`Field '${fieldDef.name}' must be one of: ${fieldDef.validation.enumValues.join(', ')}`);
        }
      }
    }
    // Cross-field rules
    for (const rule of stepDef.crossFieldRules) {
      if (this.evaluateCondition(rule.if, instanceFields)) {
        const thenValue = stepFields[rule.then.field];
        if (rule.then.required && (thenValue === undefined || thenValue === null || thenValue === '')) {
          throw new Error(rule.errorMessage);
        }
      }
    }
  }

  private checkAuthorization(stepDef: StepDefinition, actor: User): void {
    const rule = stepDef.assigneeRule;
    if (rule.type === 'any_user') return;
    if (rule.type === 'role' && actor.roles.includes(rule.value!)) return;
    if (rule.type === 'specific_users' && rule.userIds?.includes(actor.id)) return;
    throw new Error(`User ${actor.id} is not authorized for step '${stepDef.name}'`);
  }

  // ── Audit Trail ────────────────────────────────────────────

  private appendAudit(
    instanceId: string, stepKey: string | null, actorId: string, action: string,
    previousState: string | null, newState: string | null,
    fieldChanges: Record<string, any> | null, reason: string | null
  ): void {
    const logs = this.auditLogs.get(instanceId) || [];
    const prevChecksum = logs.length > 0 ? logs[logs.length - 1].checksum : '';

    const entry: AuditEntry = {
      id: ++this.auditCounter,
      instanceId, stepKey, actorId, action,
      previousState, newState,
      fieldChanges, metadata: null, reason,
      timestamp: new Date(),
      checksum: '', // computed below
    };

    // Hash chain: SHA-256(prev_checksum + serialized_entry)
    const payload = `${prevChecksum}|${entry.instanceId}|${entry.stepKey}|${entry.actorId}|${entry.action}|${entry.previousState}|${entry.newState}|${JSON.stringify(entry.fieldChanges)}|${entry.reason}|${entry.timestamp.toISOString()}`;
    entry.checksum = createHash('sha256').update(payload).digest('hex');

    logs.push(entry);
    this.auditLogs.set(instanceId, logs);
  }

  getAuditTrail(instanceId: string): AuditEntry[] {
    const logs = this.auditLogs.get(instanceId);
    if (!logs) throw new Error(`No audit trail found for instance ${instanceId}`);
    return [...logs]; // return a copy to prevent external mutation
  }

  // ── Audit Verification ─────────────────────────────────────

  verifyAuditIntegrity(instanceId: string): { valid: boolean; brokenAtIndex?: number } {
    const logs = this.auditLogs.get(instanceId);
    if (!logs) throw new Error(`No audit trail found for instance ${instanceId}`);

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      const prevChecksum = i > 0 ? logs[i - 1].checksum : '';
      const payload = `${prevChecksum}|${entry.instanceId}|${entry.stepKey}|${entry.actorId}|${entry.action}|${entry.previousState}|${entry.newState}|${JSON.stringify(entry.fieldChanges)}|${entry.reason}|${entry.timestamp.toISOString()}`;
      const expected = createHash('sha256').update(payload).digest('hex');
      if (entry.checksum !== expected) {
        return { valid: false, brokenAtIndex: i };
      }
    }
    return { valid: true };
  }

  // ── Query Helpers ──────────────────────────────────────────

  getInstance(instanceId: string): ProcessInstance | undefined {
    return this.instances.get(instanceId);
  }
}
