import { validateRoleStageTemplate, type RoleStageTemplate } from '../shared/role-stage';
import type { RuntimeDiagnostic } from '../shared/prompt-runtime';
import type { CharacterCard } from '../shared/types';

export interface MaterializedRoleStage { content: string; stageId?: string; unknown: boolean; diagnostics: RuntimeDiagnostic[]; }

/** The authored whole template is not a second unconditional persona channel. */
export function roleStageOwnsPersona(card: Pick<CharacterCard, 'worldbook' | 'modules'>, roleId: string, persona: string): boolean {
  return (card.worldbook?.bindings ?? []).some(binding => binding.roleStage?.roleId === roleId
    && card.modules.some(module => module.id === binding.moduleId && module.content === persona));
}

/** Caller checks the binding hash and supplies the owning role's host-authorized
 * selector value. Selecting a private stage does not grant the model access to
 * that raw number or its field declaration. */
export function materializeRoleStage(body: string, template: RoleStageTemplate, ownRoleStateValue: unknown): MaterializedRoleStage {
  const issues = validateRoleStageTemplate(template, body);
  if (issues.length) return { content: '', unknown: true, diagnostics: [{ code: 'role-stage-invalid', severity: 'error', message: 'Invalid role stage template; no body text was delivered.' }] };
  const known = typeof ownRoleStateValue === 'number' && Number.isFinite(ownRoleStateValue);
  const stage = known ? template.stages.find(stage => (stage.min === undefined || ownRoleStateValue >= stage.min) && (stage.max === undefined || ownRoleStateValue < stage.max)) : undefined;
  const selected = template.parts.filter(part => part.stageId === undefined || part.stageId === stage?.id)
    .map(part => ({ start: part.start, content: body.slice(part.start, part.end) }));
  if (stage) for (const output of template.outputs ?? []) selected.push({ start: output.start, content: stage.label! });
  const content = selected.sort((a, b) => a.start - b.start).map(part => part.content).join('');
  return { content, ...(stage ? { stageId: stage.id } : {}), unknown: !known,
    diagnostics: known ? [] : [{ code: 'role-stage-unknown', severity: 'warning', message: 'The owning role field is not a known finite number; only common text was delivered.' }] };
}
