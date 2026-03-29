import { createHash } from 'node:crypto';
import { AuditEntry, AuditFieldChanges } from './types';

export type AuditIdSource = { next(): number };

export function createAuditIdCounter(start = 0): AuditIdSource {
  let n = start;
  return { next: () => ++n };
}

export function appendChainedAuditEntry(
  logs: AuditEntry[],
  ids: AuditIdSource,
  params: {
    instanceId: string;
    stepKey: string | null;
    actorId: string;
    action: string;
    previousState: string | null;
    newState: string | null;
    fieldChanges: AuditFieldChanges | null;
    reason: string | null;
  },
): void {
  const prevChecksum = logs.length > 0 ? logs[logs.length - 1].checksum : '';
  const entry: AuditEntry = {
    id: ids.next(),
    ...params,
    metadata: null,
    timestamp: new Date(),
    checksum: '',
  };
  const payload = `${prevChecksum}|${entry.instanceId}|${entry.stepKey}|${entry.actorId}|${entry.action}|${entry.previousState}|${entry.newState}|${JSON.stringify(entry.fieldChanges)}|${entry.reason}|${entry.timestamp.toISOString()}`;
  entry.checksum = createHash('sha256').update(payload).digest('hex');
  logs.push(entry);
}

export function verifyChainedAuditEntries(logs: AuditEntry[]): { valid: boolean; brokenAtIndex?: number } {
  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i];
    const prevChecksum = i > 0 ? logs[i - 1].checksum : '';
    const payload = `${prevChecksum}|${entry.instanceId}|${entry.stepKey}|${entry.actorId}|${entry.action}|${entry.previousState}|${entry.newState}|${JSON.stringify(entry.fieldChanges)}|${entry.reason}|${entry.timestamp.toISOString()}`;
    const expected = createHash('sha256').update(payload).digest('hex');
    if (entry.checksum !== expected) return { valid: false, brokenAtIndex: i };
  }
  return { valid: true };
}
