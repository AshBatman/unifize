import { appendChainedAuditEntry, createAuditIdCounter, verifyChainedAuditEntries } from './audit-chain';
import {
  AuthorizationError,
  DefinitionError,
  NotFoundError,
  StateError,
  TransitionError,
  ValidationError,
} from './errors';
import { findTransition, validateFields } from './field-ops';
import { InstanceLockManager } from './instance-lock';
import { handleChecklist, handleParallelApproval } from './step-handlers';
import {
  Action,
  AuditEntry,
  AuditFieldChanges,
  FieldBag,
  ProcessDefinition,
  ProcessInstance,
  StepDefinition,
  StepInstance,
  StepResult,
  StepStatus,
  User,
} from './types';

/**
 * In-process process engine. Instance mutations (`advanceStep`, `markChecklistItem`) are
 * serialized per `instanceId` via a synchronous lock; use an external store lock when
 * multiple processes or nodes can mutate the same instance.
 */
export class ProcessEngine {
  private definitions = new Map<string, ProcessDefinition>();
  private instances = new Map<string, ProcessInstance>();
  private auditLogs = new Map<string, AuditEntry[]>();
  private auditIds = createAuditIdCounter(0);
  private instanceLocks = new InstanceLockManager();

  loadDefinition(def: ProcessDefinition): void {
    if (!def.id || !def.steps.length) {
      throw new DefinitionError('definition_invalid', 'Definition must have an ID and at least one step');
    }
    if (this.definitions.has(def.id)) {
      throw new DefinitionError('definition_exists', `Definition ${def.id} already loaded`);
    }
    const stepKeys = new Set(def.steps.map(s => s.stepKey));
    for (const t of def.transitions) {
      if (!stepKeys.has(t.fromStepKey) || !stepKeys.has(t.toStepKey)) {
        throw new DefinitionError(
          'transition_invalid',
          `Transition references unknown step: ${t.fromStepKey} → ${t.toStepKey}`,
        );
      }
    }
    this.definitions.set(def.id, def);
  }

  startProcess(definitionId: string, initiator: User, fields: FieldBag): ProcessInstance {
    const def = this.definitions.get(definitionId);
    if (!def) throw new NotFoundError('definition_not_found', `Definition ${definitionId} not found`);

    const firstStep = def.steps.sort((a, b) => a.order - b.order)[0];
    validateFields(firstStep, fields, fields);

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
        checklistItems: (stepDef.checklistItems || []).map(text => ({ text, completed: false })),
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

  advanceStep(instanceId: string, stepKey: string, action: Action, actor: User): StepResult {
    return this.instanceLocks.runExclusive(instanceId, () => this.advanceStepUnlocked(instanceId, stepKey, action, actor));
  }

  private advanceStepUnlocked(instanceId: string, stepKey: string, action: Action, actor: User): StepResult {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new NotFoundError('instance_not_found', `Instance ${instanceId} not found`);
    if (instance.status !== 'active') {
      throw new StateError('instance_not_active', `Instance is ${instance.status}, not active`);
    }

    const def = this.definitions.get(instance.definitionId)!;
    const stepDef = def.steps.find(s => s.stepKey === stepKey);
    if (!stepDef) throw new NotFoundError('step_not_found', `Step ${stepKey} not found in definition`);

    const stepInst = instance.steps.get(stepKey)!;
    if (stepInst.status !== 'in_progress') {
      throw new StateError('step_invalid_state', `Step ${stepKey} is ${stepInst.status}, cannot advance`);
    }

    this.checkAuthorization(stepDef, actor);

    if (action.fields) {
      Object.assign(stepInst.fields, action.fields);
      Object.assign(instance.fields, action.fields);
    }

    const audit = this.appendAudit.bind(this);
    const next = this.activateNextStep.bind(this);

    if (stepDef.type === 'parallel_approval') {
      return handleParallelApproval(instance, stepDef, stepInst, action, actor, def, audit, next);
    }

    if (stepDef.type === 'checklist' && action.type === 'complete') {
      return handleChecklist(instance, stepDef, stepInst, actor, def, audit, next);
    }

    if (action.type === 'complete' || action.type === 'approve') {
      validateFields(stepDef, stepInst.fields, instance.fields);
    }

    const transition = findTransition(def, stepKey, action.type, instance.fields);
    if (!transition) {
      throw new TransitionError(`No valid transition from step ${stepKey} with action ${action.type}`);
    }

    const previousStatus = stepInst.status;
    const newStatus: StepStatus = action.type === 'reject' ? 'rejected' : 'completed';
    stepInst.status = newStatus;
    stepInst.completedAt = new Date();

    this.appendAudit(instanceId, stepKey, actor.id, action.type, previousStatus, newStatus, action.fields || null, action.comments || null);
    return this.activateNextStep(instance, transition.toStepKey, actor, previousStatus, newStatus, stepKey);
  }

  markChecklistItem(instanceId: string, stepKey: string, itemIndex: number, actor: User): void {
    this.instanceLocks.runExclusive(instanceId, () => {
      const instance = this.instances.get(instanceId);
      if (!instance) throw new NotFoundError('instance_not_found', `Instance ${instanceId} not found`);
      const stepInst = instance.steps.get(stepKey)!;
      if (stepInst.status !== 'in_progress') {
        throw new StateError('step_invalid_state', `Step ${stepKey} is not in progress`);
      }
      if (itemIndex < 0 || itemIndex >= stepInst.checklistItems.length) {
        throw new ValidationError('Invalid checklist item index');
      }
      const item = stepInst.checklistItems[itemIndex];
      item.completed = true;
      item.completedBy = actor.id;
      item.completedAt = new Date();
      this.appendAudit(instanceId, stepKey, actor.id, 'checklist_item_completed', null, null, {
        [item.text]: { before: false, after: true },
      }, null);
    });
  }

  private activateNextStep(
    instance: ProcessInstance,
    nextStepKey: string,
    actor: User,
    previousStatus: StepStatus,
    newStatus: StepStatus,
    fromStepKey: string,
  ): StepResult {
    if (nextStepKey === fromStepKey && newStatus === 'completed') {
      instance.status = 'completed';
      instance.updatedAt = new Date();
      this.appendAudit(instance.id, null, 'system', 'process_completed', 'active', 'completed', null, null);
      return { success: true, instanceId: instance.id, stepKey: fromStepKey, previousStatus, newStatus: 'completed' };
    }

    const nextStep = instance.steps.get(nextStepKey);
    if (!nextStep) {
      instance.status = 'completed';
      instance.updatedAt = new Date();
      this.appendAudit(instance.id, null, 'system', 'process_completed', 'active', 'completed', null, null);
      return { success: true, instanceId: instance.id, stepKey: fromStepKey, previousStatus, newStatus };
    }

    nextStep.status = 'in_progress';
    nextStep.startedAt = new Date();
    nextStep.completedAt = undefined;
    nextStep.approvals = nextStep.approvals.map(a => ({ ...a, decision: 'pending' as const, decidedAt: undefined }));
    instance.currentStepKey = nextStepKey;
    instance.updatedAt = new Date();
    this.appendAudit(instance.id, nextStepKey, 'system', 'step_activated', 'pending', 'in_progress', null, null);

    return {
      success: true,
      instanceId: instance.id,
      stepKey: fromStepKey,
      previousStatus,
      newStatus,
      nextStepKey,
    };
  }

  private checkAuthorization(stepDef: StepDefinition, actor: User): void {
    const rule = stepDef.assigneeRule;
    if (rule.type === 'any_user') return;
    if (rule.type === 'role' && actor.roles.includes(rule.value!)) return;
    if (rule.type === 'specific_users' && rule.userIds?.includes(actor.id)) return;
    throw new AuthorizationError(`User ${actor.id} is not authorized for step '${stepDef.name}'`);
  }

  private appendAudit(
    instanceId: string,
    stepKey: string | null,
    actorId: string,
    action: string,
    previousState: string | null,
    newState: string | null,
    fieldChanges: AuditFieldChanges | null,
    reason: string | null,
  ): void {
    const logs = this.auditLogs.get(instanceId) || [];
    appendChainedAuditEntry(logs, this.auditIds, {
      instanceId,
      stepKey,
      actorId,
      action,
      previousState,
      newState,
      fieldChanges,
      reason,
    });
    this.auditLogs.set(instanceId, logs);
  }

  getAuditTrail(instanceId: string): AuditEntry[] {
    const logs = this.auditLogs.get(instanceId);
    if (!logs) throw new NotFoundError('audit_not_found', `No audit trail found for instance ${instanceId}`);
    return [...logs];
  }

  verifyAuditIntegrity(instanceId: string): { valid: boolean; brokenAtIndex?: number } {
    const logs = this.auditLogs.get(instanceId);
    if (!logs) throw new NotFoundError('audit_not_found', `No audit trail found for instance ${instanceId}`);
    return verifyChainedAuditEntries(logs);
  }

  getInstance(instanceId: string): ProcessInstance | undefined {
    return this.instances.get(instanceId);
  }
}
