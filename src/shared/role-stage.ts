/** Declarative slices over the unchanged module body. All offsets are UTF-16. */
export interface RoleStageRange { start: number; end: number; }
export interface RoleStageTemplate {
  schema: 'rp.role-stage/0.1';
  roleId: string;
  field: string;
  stages: { id: string; label?: string; min?: number; max?: number }[];
  parts: (RoleStageRange & { stageId?: string })[];
  controlRanges?: RoleStageRange[];
  outputs?: (RoleStageRange & { kind: 'stage-label' })[];
}
export interface RoleStageIssue { path: string; message: string; }

/** Hash, role ownership, field declarations and disclosure permissions are binding checks. */
export function validateRoleStageTemplate(value: unknown, body: string): RoleStageIssue[] {
  const issues: RoleStageIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  const record = (node: unknown): node is Record<string, unknown> => !!node && typeof node === 'object' && !Array.isArray(node);
  if (!record(value)) return [{ path: '', message: 'Expected a role stage template object.' }];
  if (value.schema !== 'rp.role-stage/0.1') issue('/schema', 'Unsupported role stage schema.');
  for (const field of ['roleId', 'field']) if (typeof value[field] !== 'string' || !(value[field] as string).trim()) issue(`/${field}`, 'Expected a nonempty string.');
  const ids = new Set<string>();
  if (!Array.isArray(value.stages) || !value.stages.length) issue('/stages', 'At least one stage is required.');
  else value.stages.forEach((stage: unknown, index: number) => {
    const path = `/stages/${index}`;
    if (!record(stage)) { issue(path, 'Expected a stage object.'); return; }
    if (typeof stage.id !== 'string' || !stage.id.trim()) issue(`${path}/id`, 'Expected a nonempty stage id.');
    else { if (ids.has(stage.id)) issue(`${path}/id`, 'Stage ids must be unique.'); ids.add(stage.id); }
    if (Object.hasOwn(stage, 'label') && (typeof stage.label !== 'string' || !stage.label.trim())) issue(`${path}/label`, 'Expected a nonempty literal stage label.');
    for (const bound of ['min', 'max']) if (Object.hasOwn(stage, bound) && (typeof stage[bound] !== 'number' || !Number.isFinite(stage[bound]))) issue(`${path}/${bound}`, 'Bounds must be finite numbers.');
    if (index === 0 && Object.hasOwn(stage, 'min')) issue(`${path}/min`, 'The first stage must cover negative infinity by omitting min.');
    if (index > 0 && !Object.hasOwn(stage, 'min')) issue(`${path}/min`, 'Only the first stage may omit min.');
    if (index === (value.stages as unknown[]).length - 1 && Object.hasOwn(stage, 'max')) issue(`${path}/max`, 'The last stage must cover positive infinity by omitting max.');
    if (index < (value.stages as unknown[]).length - 1 && !Object.hasOwn(stage, 'max')) issue(`${path}/max`, 'Only the last stage may omit max.');
    if (typeof stage.min === 'number' && typeof stage.max === 'number' && stage.min >= stage.max) issue(path, 'A stage must have a nonempty interval.');
    const previous = (value.stages as unknown[])[index - 1];
    if (index > 0 && record(previous) && previous.max !== stage.min) issue(`${path}/min`, 'Stages must be contiguous, ordered and nonoverlapping.');
  });
  const ranges: (RoleStageRange & { path: string; control: boolean })[] = [];
  const seenStages = new Set<string>();
  const splitsSurrogate = (offset: number) => offset > 0 && offset < body.length && /[\uD800-\uDBFF]/.test(body[offset - 1]) && /[\uDC00-\uDFFF]/.test(body[offset]);
  const inspectRanges = (nodes: unknown, key: 'parts' | 'controlRanges') => {
    if (!Array.isArray(nodes)) { issue(`/${key}`, 'Expected an array of text ranges.'); return; }
    nodes.forEach((node: unknown, index: number) => {
      const path = `/${key}/${index}`;
      if (!record(node)) { issue(path, 'Expected a range object.'); return; }
      const { start, end } = node;
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > body.length || splitsSurrogate(start) || splitsSurrogate(end)) issue(path, 'Expected a nonempty in-bounds UTF-16 range without splitting a surrogate pair.');
      else ranges.push({ start, end, path, control: key === 'controlRanges' });
      if (key === 'parts' && Object.hasOwn(node, 'stageId')) {
        if (typeof node.stageId !== 'string' || !ids.has(node.stageId)) issue(`${path}/stageId`, 'Unknown stage reference.');
        else seenStages.add(node.stageId);
      }
      if (key === 'controlRanges' && Object.hasOwn(node, 'stageId')) issue(`${path}/stageId`, 'Control ranges cannot select a stage.');
    });
  };
  inspectRanges(value.parts, 'parts');
  if (value.controlRanges !== undefined) inspectRanges(value.controlRanges, 'controlRanges');
  for (const id of ids) if (!seenStages.has(id)) issue('/parts', 'Every stage must have a text part.');
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  for (const range of ranges) { if (range.start !== cursor) issue(range.path, 'Parts and control ranges must form a complete, nonoverlapping body partition.'); cursor = Math.max(cursor, range.end); }
  if (cursor !== body.length) issue('/parts', 'Parts and control ranges must cover the complete body.');
  // No EJS tag, including an output tag, may become model-visible text.
  for (const match of body.matchAll(/<%[\s\S]*?(?:%>|$)/g)) {
    const start = match.index!, end = start + match[0].length;
    if (!ranges.some(range => range.control && range.start <= start && range.end >= end)) issue('/controlRanges', 'EJS tags must be contained in excluded control ranges.');
  }
  if (value.outputs !== undefined) {
    if (!Array.isArray(value.outputs)) issue('/outputs', 'Expected an array of declarative output ranges.');
    else {
      const outputRanges: RoleStageRange[] = [];
      value.outputs.forEach((output: unknown, index: number) => {
        const path = `/outputs/${index}`;
        if (!record(output)) { issue(path, 'Expected a stage label output object.'); return; }
        const { start, end } = output;
        if (output.kind !== 'stage-label') issue(`${path}/kind`, 'Unsupported declarative output kind.');
        if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > body.length || !ranges.some(range => range.control && range.start <= start && range.end >= end) || !/^<%=\s*stage\s*%>$/.test(body.slice(start, end))) issue(path, 'A stage label output must cover a complete supported echo tag inside a control range.');
        else {
          if (outputRanges.some(range => range.start < end && start < range.end)) issue(path, 'Output ranges must not overlap.');
          outputRanges.push({ start, end });
        }
      });
      if (value.outputs.length && Array.isArray(value.stages)) value.stages.forEach((stage: unknown, index: number) => {
        if (record(stage) && (typeof stage.label !== 'string' || !stage.label.trim())) issue(`/stages/${index}/label`, 'A literal label is required for every stage when label outputs are declared.');
      });
    }
  }
  return issues;
}
