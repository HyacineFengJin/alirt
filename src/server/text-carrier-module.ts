import type { AgentModule } from './agent-modules';
import { TEXT_CARRIER_VIEW_MODULE_ID } from '../shared/text-carriers';

/** Installed trusted capability, disabled unless the author explicitly grants
 * it. Media presentation and author/player controls have independent gates. */
export const textCarrierViewModule: AgentModule = {
  meta: { id: TEXT_CARRIER_VIEW_MODULE_ID, version: '0.1.0', apiVersion: 'rp.agent-module/0.1',
    title: '查看场景文字载体', description: 'NPC 可提出查看已登记的本地纸张或屏幕；世界确认后才获得正文。', requires: ['rp.role-agents'] },
  roleTools: ({ carrierViews }) => !carrierViews?.targets.length ? [] : [{
    name: 'propose_carrier_view', description: 'Propose this NPC attempting to view one delivered local text carrier version. Returns a pending action, never its body. Reading occurs only after world approval; do not invent its contents or act as another reader.',
    parameters: { type: 'object', additionalProperties: false, required: ['carrierId', 'version'], properties: {
      carrierId: { type: 'string', enum: carrierViews.targets.map(target => target.carrierId) }, version: { type: 'integer', minimum: 1 },
    } }, execute: input => carrierViews.propose(input),
  }],
};
