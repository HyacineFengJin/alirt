import type { RoleInteraction } from './types';

/** Strict grant reader for persisted snapshots as well as validated native documents. */
export function isRemoteInteraction(value: unknown): value is Extract<RoleInteraction, { mode: 'remote' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.mode === 'remote'
    && ['message', 'screen', 'audio'].includes(record.channel as string);
}
