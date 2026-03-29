// ============================================================
// Domain Types for the Process Execution Engine
// ============================================================

export interface User {
  id: string;
  name: string;
  roles: string[];
}

// --- Process Definition Types (Blueprint) ---

export type StepType = 'task' | 'approval' | 'parallel_approval' | 'review' | 'checklist' | 'signature';
export type ActionType = 'complete' | 'approve' | 'reject' | 'escalate' | 'reopen';
export type FieldType = 'text' | 'number' | 'enum' | 'boolean' | 'date';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required: boolean;
  validation?: {
    pattern?: string;
    enumValues?: string[];
    min?: number;
    max?: number;
  };
}

export interface CrossFieldRule {
  if: { field: string; op: 'eq' | 'neq' | 'gt' | 'lt'; value: any };
  then: { field: string; required: boolean };
  errorMessage: string;
}

export interface TransitionRule {
  fromStepKey: string;
  toStepKey: string;
  action: ActionType;
  condition?: { field: string; op: 'eq' | 'neq' | 'gt' | 'lt'; value: any } | null;
  priority: number;
}

export interface EscalationRule {
  timeoutHours: number;
  escalateTo: { type: 'role' | 'user'; value: string };
  condition?: { field: string; op: 'eq' | 'neq'; value: any } | null;
}

export interface StepDefinition {
  stepKey: string;
  name: string;
  order: number;
  type: StepType;
  assigneeRule: { type: 'any_user' | 'role' | 'specific_users'; value?: string; userIds?: string[] };
  fields: FieldDefinition[];
  crossFieldRules: CrossFieldRule[];
  escalation?: EscalationRule;
  checklistItems?: string[];  // for checklist step type
  requiredApprovers?: string[];  // user IDs for parallel_approval
}

export interface ProcessDefinition {
  id: string;
  name: string;
  version: number;
  steps: StepDefinition[];
  transitions: TransitionRule[];
}

// --- Process Instance Types (Runtime) ---

export type ProcessStatus = 'active' | 'completed' | 'cancelled' | 'suspended';
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'skipped' | 'escalated';

export interface StepApproval {
  approverId: string;
  decision: 'approved' | 'rejected' | 'pending';
  comments?: string;
  decidedAt?: Date;
}

export interface ChecklistItemState {
  text: string;
  completed: boolean;
  completedBy?: string;
  completedAt?: Date;
}

export interface StepInstance {
  instanceId: string;
  stepKey: string;
  status: StepStatus;
  assignedTo?: string;
  fields: Record<string, any>;
  approvals: StepApproval[];
  checklistItems: ChecklistItemState[];
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProcessInstance {
  id: string;
  definitionId: string;
  status: ProcessStatus;
  initiatedBy: string;
  fields: Record<string, any>;
  currentStepKey: string;
  steps: Map<string, StepInstance>;
  createdAt: Date;
  updatedAt: Date;
}

// --- Action & Result Types ---

export interface Action {
  type: ActionType;
  fields?: Record<string, any>;
  comments?: string;
  checklistItemIndex?: number;  // for marking checklist items
}

export interface StepResult {
  success: boolean;
  instanceId: string;
  stepKey: string;
  previousStatus: StepStatus;
  newStatus: StepStatus;
  nextStepKey?: string;
  error?: string;
  waitingOn?: string[];  // for parallel approvals: who hasn't decided yet
}

// --- Audit Types ---

export interface AuditEntry {
  id: number;
  instanceId: string;
  stepKey: string | null;
  actorId: string;
  action: string;
  previousState: string | null;
  newState: string | null;
  fieldChanges: Record<string, { before: any; after: any }> | null;
  metadata: Record<string, any> | null;
  reason: string | null;
  timestamp: Date;
  checksum: string;
}
