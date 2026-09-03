import { InstanceRow } from './types';

const UNAVAILABLE_ASSIGNMENT_STATES = new Set(['STOPPED', 'STOPPING', 'DESTROYED', 'REPLACED', 'REPLACING']);

export function assignmentUnavailableReason(instance: InstanceRow | undefined): string | null {
  if (!instance) return 'assigned instance is no longer managed';
  if (UNAVAILABLE_ASSIGNMENT_STATES.has(instance.state)) return `assigned instance is ${instance.state}`;
  return null;
}

