import type { BehaviorCandidate } from '../shared/behavior';
import type { ProseEntry, RoleDefinition, SubmitTurn, WorldEvent } from '../shared/types';

export const NARRATION_BRIEF_SCHEMA = 'rp.narration-brief/0.1';

/** Source notation is an identity hint, never a textual replacement rule. */
export function playerIdentity(session: { playerRoleId: string; roles: Pick<RoleDefinition, 'id' | 'name'>[] }) {
  const player = session.roles.find(role => role.id === session.playerRoleId);
  if (!player) throw new Error('The narration player identity is unavailable.');
  return { roleId: player.id, displayName: player.name, sourceNotations: ['<user>', '{{user}}'] };
}

type MaterialRole = Pick<RoleDefinition, 'id' | 'name' | 'presence'>;
/** Construct only from the public projection and durable current-turn material.
 * Persona, private state, peer mail and role reports are intentionally not inputs.
 * This describes available evidence; it does not certify natural-language truth. */
export function narrationBrief(input: {
  revision: number;
  playerRoleId: string;
  roles: MaterialRole[];
  materialTurnId?: string;
  playerMode: SubmitTurn['mode'];
  acceptedBehaviors: BehaviorCandidate[];
  events: WorldEvent[];
  previousProse?: ProseEntry;
}) {
  return {
    schema: NARRATION_BRIEF_SCHEMA,
    revision: input.revision,
    materialTurnId: input.materialTurnId ?? null,
    player: playerIdentity(input),
    scene: {
      physicalRoleIds: input.roles.filter(role => role.presence === 'present').map(role => role.id),
      transmissions: input.acceptedBehaviors.flatMap(behavior => behavior.interaction?.mode === 'remote' ? [{
        behaviorId: behavior.id, roleId: behavior.roleId, channel: behavior.interaction.channel,
      }] : []),
      otherRoles: 'Reference identities and disclosed state only; their unseen current activity is not supplied.',
    },
    evidence: {
      playerAction: { path: 'playerControl.authorizedAction', mode: input.playerMode },
      behaviorIds: input.acceptedBehaviors.map(behavior => behavior.id),
      factEventIds: input.events.filter(event => event.kind === 'world-event' && event.audience === 'public' && event.turnId === input.materialTurnId).map(event => event.id),
      state: 'Declared public state in this revision; numeric affinity does not disclose thoughts or feelings.',
      privateInteriority: 'Not supplied through a private channel. Use only feelings explicitly disclosed in public facts/state; a psychology request is not new disclosure.',
    },
    previousProse: input.previousProse ? {
      entryId: input.previousProse.id, turnId: input.previousProse.turnId ?? null,
      worldRevision: input.previousProse.worldRevision, authority: 'Style and continuity only; generated details do not authorize facts or actions.',
    } : null,
  };
}

export const NARRATION_MATERIAL_PROTOCOL = `Host rendering contract ${NARRATION_BRIEF_SCHEMA}: narrationBrief separates presentation from evidence. Choose person, focus, montage and style within narration settings. These choices, source plans and presets never grant new actor choices or private disclosure. Render the authorized player action and world-approved behavior in their supplied order. Describe and connect supplied facts naturally; do not add new actor gestures, movements, dialogue, memories or feelings as decorative details. Public numeric affinity does not reveal interiority. Remote transmissions authorize their channel and exact approved content only: message is text, audio is sound, screen does not grant unseen surroundings. A cutaway may render independently supplied public facts; a transmission alone does not establish the sender's room, physical activity or thoughts. Use the player's displayName naturally when source notation such as <user> refers to that identity; preserve literal code/quoted material rather than replacing arbitrary strings. Auxiliary summaries use the same committed evidence, not inventions from generated prose. Preserve partial or unknown time; do not infer an elapsed interval, emotion change or offstage event to fill a requested format. Prior prose and native transcript history are style/continuity material, not new factual authority. If a requested view has no disclosure material, omit unsupported content rather than inventing it.`;

export const NARRATION_TASK_REMINDER = '[Host rendering boundary] Use narrationBrief and current committed material for authority. Preset camera/psychology/player-expansion requests control presentation only; they cannot supply missing actions, feelings, disclosures or elapsed time.';
