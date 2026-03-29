import { ValidationError } from './errors';
import {
  ActionType,
  FieldBag,
  ProcessDefinition,
  StepDefinition,
  TransitionRule,
} from './types';

export function evaluateCondition(
  condition: { field: string; op: string; value: unknown },
  fields: FieldBag,
): boolean {
  const fieldValue = fields[condition.field];
  switch (condition.op) {
    case 'eq':
      return fieldValue === condition.value;
    case 'neq':
      return fieldValue !== condition.value;
    case 'gt':
      return (fieldValue as number) > (condition.value as number);
    case 'lt':
      return (fieldValue as number) < (condition.value as number);
    default:
      return false;
  }
}

export function findTransition(
  def: ProcessDefinition,
  fromStepKey: string,
  action: ActionType,
  fields: FieldBag,
): TransitionRule | null {
  const candidates = def.transitions
    .filter(t => t.fromStepKey === fromStepKey && t.action === action)
    .sort((a, b) => b.priority - a.priority);

  for (const t of candidates) {
    if (!t.condition || evaluateCondition(t.condition, fields)) return t;
  }
  return null;
}

export function validateFields(
  stepDef: StepDefinition,
  stepFields: FieldBag,
  instanceFields: FieldBag,
): void {
  for (const fieldDef of stepDef.fields) {
    const value = stepFields[fieldDef.name];
    if (fieldDef.required && (value === undefined || value === null || value === '')) {
      throw new ValidationError(`Field '${fieldDef.name}' is required in step '${stepDef.name}'`);
    }
    if (value && fieldDef.validation?.pattern) {
      if (!new RegExp(fieldDef.validation.pattern).test(String(value))) {
        throw new ValidationError(`Field '${fieldDef.name}' does not match pattern ${fieldDef.validation.pattern}`);
      }
    }
    if (value && fieldDef.validation?.enumValues) {
      if (!fieldDef.validation.enumValues.includes(String(value))) {
        throw new ValidationError(`Field '${fieldDef.name}' must be one of: ${fieldDef.validation.enumValues.join(', ')}`);
      }
    }
  }
  for (const rule of stepDef.crossFieldRules) {
    if (evaluateCondition(rule.if, instanceFields)) {
      const thenValue = stepFields[rule.then.field];
      if (rule.then.required && (thenValue === undefined || thenValue === null || thenValue === '')) {
        throw new ValidationError(rule.errorMessage);
      }
    }
  }
}
