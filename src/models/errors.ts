export type EngineErrorCode =
  | 'definition_invalid'
  | 'definition_exists'
  | 'definition_not_found'
  | 'transition_invalid'
  | 'instance_not_found'
  | 'instance_not_active'
  | 'step_not_found'
  | 'step_invalid_state'
  | 'validation_failed'
  | 'authorization_failed'
  | 'transition_not_found'
  | 'audit_not_found'
  | 'concurrency_conflict';

export abstract class EngineError extends Error {
  abstract readonly code: EngineErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends EngineError {
  readonly code = 'validation_failed' as const;
}

export class AuthorizationError extends EngineError {
  readonly code = 'authorization_failed' as const;
}

export class NotFoundError extends EngineError {
  constructor(
    public readonly code: 'definition_not_found' | 'instance_not_found' | 'step_not_found' | 'audit_not_found',
    message: string,
  ) {
    super(message);
  }
}

export class DefinitionError extends EngineError {
  constructor(
    public readonly code: 'definition_invalid' | 'definition_exists' | 'transition_invalid',
    message: string,
  ) {
    super(message);
  }
}

export class StateError extends EngineError {
  constructor(
    public readonly code: 'instance_not_active' | 'step_invalid_state',
    message: string,
  ) {
    super(message);
  }
}

export class TransitionError extends EngineError {
  readonly code = 'transition_not_found' as const;
}

export class ConcurrencyError extends EngineError {
  readonly code = 'concurrency_conflict' as const;

  constructor(instanceId: string) {
    super(`Another operation is in progress for instance ${instanceId}; callers must serialize mutations per instance.`);
  }
}
