import { isDeepStrictEqual } from 'node:util';
import type { DraftPatchOperation, NativeDocument } from '../shared/creator';
import { clone, fail } from './store';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function assertCreatorDocument(value: unknown): asserts value is NativeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CREATOR_DOCUMENT', 'A draft must be a JSON object');
  const ancestry = new Set<object>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 128) fail('CREATOR_DOCUMENT_DEPTH', 'Draft nesting exceeds the supported JSON depth');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (typeof node !== 'object' || !node || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(node))) fail('CREATOR_DOCUMENT', 'Drafts must contain ordinary lossless JSON values');
    if (ancestry.has(node)) fail('CREATOR_DOCUMENT', 'Cyclic drafts are not JSON');
    ancestry.add(node);
    for (const key of Reflect.ownKeys(node)) {
      if (Array.isArray(node) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      if (typeof key !== 'string' || !('value' in descriptor)) fail('CREATOR_DOCUMENT', 'Draft accessors and symbol properties are not JSON');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(node) && Object.keys(node).length !== node.length) fail('CREATOR_DOCUMENT', 'Sparse or decorated arrays are not supported JSON');
    ancestry.delete(node);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32 * 1024 * 1024) fail('CREATOR_DOCUMENT_SIZE', 'Draft exceeds the 32 MiB document size limit', 413);
}

function pointer(path: unknown): string[] {
  if (typeof path !== 'string' || path !== '' && !path.startsWith('/')) fail('CREATOR_POINTER', 'Use a JSON Pointer starting with /');
  if (path === '') return [];
  return path.slice(1).split('/').map(segment => {
    if (/~(?![01])/u.test(segment)) fail('CREATOR_POINTER', 'Invalid JSON Pointer escape');
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (forbidden.has(key)) fail('CREATOR_POINTER', 'Prototype-related paths are forbidden');
    return key;
  });
}
function arrayIndex(key: string, length: number, add = false): number {
  if (add && key === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(key)) fail('CREATOR_POINTER', 'Array indices must be canonical nonnegative integers');
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length + (add ? 1 : 0)) fail('CREATOR_POINTER', 'Array index is out of bounds');
  return index;
}
/** Apply to a clone; no partial operation or failed test can mutate the draft. */
export function patchCreatorDocument(document: NativeDocument, operations: unknown): NativeDocument {
  if (!Array.isArray(operations) || !operations.length) fail('CREATOR_PATCH', 'Provide at least one JSON Patch operation');
  let next: any = clone(document);
  for (const operation of operations as DraftPatchOperation[]) {
    if (!operation || typeof operation !== 'object' || Object.keys(operation).some(key => !['op', 'path', 'value'].includes(key))
      || !['add', 'replace', 'remove', 'test'].includes(operation.op)) fail('CREATOR_PATCH', 'Unsupported patch operation');
    const parts = pointer(operation.path), hasValue = Object.hasOwn(operation, 'value');
    if (operation.op !== 'remove' && !hasValue || operation.op === 'remove' && hasValue) fail('CREATOR_PATCH', 'Patch value does not match its operation');
    if (hasValue) assertCreatorDocument({ value: operation.value });
    if (!parts.length) {
      if (operation.op === 'test') { if (!isDeepStrictEqual(next, operation.value)) fail('CREATOR_PATCH_TEST', 'Draft test failed', 409); }
      else if (operation.op === 'remove') fail('CREATOR_DOCUMENT', 'Removing the whole draft is not supported');
      else { assertCreatorDocument(operation.value); next = clone(operation.value); }
      continue;
    }
    let parent: any = next;
    for (const key of parts.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') fail('CREATOR_POINTER', 'Pointer parent is not a container');
      if (Array.isArray(parent)) parent = parent[arrayIndex(key, parent.length)];
      else { if (!Object.hasOwn(parent, key)) fail('CREATOR_POINTER', 'Pointer parent does not exist'); parent = parent[key]; }
    }
    if (!parent || typeof parent !== 'object') fail('CREATOR_POINTER', 'Pointer parent is not a container');
    const key = parts.at(-1)!;
    const index = Array.isArray(parent) ? arrayIndex(key, parent.length, operation.op === 'add') : undefined;
    const property = index ?? key;
    if (operation.op !== 'add' && !Object.hasOwn(parent, property)) fail('CREATOR_POINTER', 'Patch target does not exist');
    if (operation.op === 'test') { if (!isDeepStrictEqual(parent[property], operation.value)) fail('CREATOR_PATCH_TEST', 'Draft test failed', 409); }
    else if (operation.op === 'remove') { if (index !== undefined) parent.splice(index, 1); else delete parent[property]; }
    else if (operation.op === 'add' && index !== undefined) parent.splice(index, 0, clone(operation.value));
    else Object.defineProperty(parent, property, { value: clone(operation.value), writable: true, enumerable: true, configurable: true });
  }
  assertCreatorDocument(next); return next;
}
