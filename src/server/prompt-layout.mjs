/** Distinct native message content blocks preserve the declared prompt slots.
 * This is our native context/task layout, not Tavern history depth emulation.
 */
export function deliveredPromptBlocks(input, layout) {
  if (!layout) return [{ type: 'text', text: JSON.stringify(input) }];
  const taskKeys = new Set(['action', 'mode', 'delivery', 'authorInstruction', 'playerControl']);
  const context = {}, task = {};
  for (const [key, value] of Object.entries(input ?? {})) (taskKeys.has(key) ? task : context)[key] = value;
  const blocks = [];
  const append = texts => { for (const text of texts ?? []) blocks.push({ type: 'text', text }); };
  append(layout.beforeContext);
  blocks.push({ type: 'text', text: 'CURRENT PERMITTED CONTEXT\n' + JSON.stringify(context) });
  append(layout.afterContext);
  append(layout.beforeAction);
  blocks.push({ type: 'text', text: 'CURRENT TASK\n' + JSON.stringify(task) });
  return blocks;
}
