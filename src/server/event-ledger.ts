import { validateStateJson, type StateValueIssue } from '../shared/state-value-schema';

/** A growing ledger is an ordinary dense array, not one state JSON value with
 * a lifetime-wide node budget. Each event retains the existing finite JSON,
 * depth and size limits independently. Event semantics belong to its consumer.
 * Inspect descriptors before reading indexes; never invoke array accessors. */
export function validateEventLedger(value: unknown): StateValueIssue[] {
  const fail = (path = ''): StateValueIssue[] => [{ path, code: 'json', message: 'Event ledger requires a plain dense JSON array without extra properties or accessors' }];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail(`/${index}`);
    const issue = validateStateJson(descriptor.value)[0];
    if (issue) return [{ ...issue, path: `/${index}${issue.path}` }];
  }
  return [];
}
