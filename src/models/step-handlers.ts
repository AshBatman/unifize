import { AuthorizationError, StateError, TransitionError, ValidationError } from './errors';
import { findTransition, validateFields } from './field-ops';
import {
  Action,
  AuditFieldChanges,
  ProcessDefinition,
  ProcessInstance,
  StepDefinition,
  StepInstance,
  StepResult,
  StepStatus,
  User,
} from './types';

export type AuditSink = (
  instanceId: string,
  stepKey: string | null,
  actorId: string,
  action: string,
  previousState: string | null,
  newState: string | null,
  fieldChanges: AuditFieldChanges | null,
  reason: string | null,
) => void;

export type ActivateNext = (
  instance: ProcessInstance,
  nextStepKey: string,
  actor: User,
  previousStatus: StepStatus,
  newStatus: StepStatus,
  fromStepKey: string,
) => StepResult;

export function handleParallelApproval(
  instance: ProcessInstance,
  stepDef: StepDefinition,
  stepInst: StepInstance,
  action: Action,
  actor: User,
  def: ProcessDefinition,
  appendAudit: AuditSink,
  activateNextStep: ActivateNext,
): StepResult {
  if (action.type !== 'approve' && action.type !== 'reject') {
    throw new ValidationError(`Parallel approval step only accepts approve/reject, got ${action.type}`);
  }

  if (stepInst.approvals.length === 0 && stepDef.requiredApprovers) {
    stepInst.approvals = stepDef.requiredApprovers.map(id => ({ approverId: id, decision: 'pending' as const }));
  }

  const approval = stepInst.approvals.find(a => a.approverId === actor.id);
  if (!approval) {
    throw new AuthorizationError(`User ${actor.id} is not a required approver for step ${stepInst.stepKey}`);
  }
  if (approval.decision !== 'pending') {
    throw new StateError('step_invalid_state', `User ${actor.id} has already decided: ${approval.decision}`);
  }

  approval.decision = action.type === 'approve' ? 'approved' : 'rejected';
  approval.comments = action.comments;
  approval.decidedAt = new Date();

  appendAudit(instance.id, stepInst.stepKey, actor.id, action.type, 'in_progress', 'in_progress', null, action.comments || null);

  const hasRejection = stepInst.approvals.some(a => a.decision === 'rejected');
  if (hasRejection) {
    stepInst.status = 'rejected';
    stepInst.completedAt = new Date();
    const tr = findTransition(def, stepInst.stepKey, 'reject', instance.fields);
    if (!tr) throw new TransitionError(`No rejection transition defined for step ${stepInst.stepKey}`);
    appendAudit(instance.id, stepInst.stepKey, 'system', 'step_rejected', 'in_progress', 'rejected', null, null);
    return activateNextStep(instance, tr.toStepKey, actor, 'in_progress', 'rejected', stepInst.stepKey);
  }

  const allApproved = stepInst.approvals.every(a => a.decision === 'approved');
  if (allApproved) {
    stepInst.status = 'completed';
    stepInst.completedAt = new Date();
    const tr = findTransition(def, stepInst.stepKey, 'approve', instance.fields);
    if (!tr) throw new TransitionError(`No approval transition defined for step ${stepInst.stepKey}`);
    appendAudit(instance.id, stepInst.stepKey, 'system', 'step_completed', 'in_progress', 'completed', null, null);
    return activateNextStep(instance, tr.toStepKey, actor, 'in_progress', 'completed', stepInst.stepKey);
  }

  const waitingOn = stepInst.approvals.filter(a => a.decision === 'pending').map(a => a.approverId);
  return {
    success: true,
    instanceId: instance.id,
    stepKey: stepInst.stepKey,
    previousStatus: 'in_progress',
    newStatus: 'in_progress',
    waitingOn,
  };
}

export function handleChecklist(
  instance: ProcessInstance,
  stepDef: StepDefinition,
  stepInst: StepInstance,
  actor: User,
  def: ProcessDefinition,
  appendAudit: AuditSink,
  activateNextStep: ActivateNext,
): StepResult {
  const allDone = stepInst.checklistItems.every(item => item.completed);
  if (!allDone) {
    throw new ValidationError('All checklist items must be completed before advancing');
  }
  validateFields(stepDef, stepInst.fields, instance.fields);
  const transition = findTransition(def, stepInst.stepKey, 'complete', instance.fields);
  if (!transition) throw new TransitionError(`No transition from checklist step ${stepInst.stepKey}`);

  stepInst.status = 'completed';
  stepInst.completedAt = new Date();
  appendAudit(instance.id, stepInst.stepKey, actor.id, 'complete', 'in_progress', 'completed', null, null);
  return activateNextStep(instance, transition.toStepKey, actor, 'in_progress', 'completed', stepInst.stepKey);
}
