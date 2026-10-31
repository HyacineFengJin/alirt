import Ajv from 'ajv';

/** Full draft-07 wire schemas, with no data rewriting. strictTypes is a schema
 * style restriction, not runtime type validation: our const-only discriminator
 * branches and nullable type arrays are valid JSON Schema and stay unchanged.
 * Official options: https://ajv.js.org/options.html
 */
const options = {
  strict: true, strictSchema: true, strictTypes: false, strictNumbers: true,
  validateSchema: true, allErrors: true, ownProperties: true,
  removeAdditional: false, coerceTypes: false, useDefaults: false,
};
function jsonViolations(value) {
  const seen = new Set(); let nodes = 0;
  function visit(node, path, depth) {
    if (++nodes > 100000 || depth > 100) return [`${path}: JSON exceeds supported size or depth`];
    if (node === null || ['string', 'boolean'].includes(typeof node) || typeof node === 'number' && Number.isFinite(node)) return [];
    if (!node || typeof node !== 'object') return [`${path}: expected finite ordinary JSON data`];
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) return [`${path}: expected ordinary JSON data`];
    if (seen.has(node)) return [`${path}: cyclic JSON data`];
    seen.add(node);
    const keys = Reflect.ownKeys(node);
    if (array && keys.length !== node.length + 1) return [`${path}: expected dense JSON array`];
    for (const key of keys) {
      if (array && key === 'length') continue;
      const field = Object.getOwnPropertyDescriptor(node, key);
      if (typeof key !== 'string' || !field.enumerable || !('value' in field) || array && !/^(0|[1-9][0-9]*)$/.test(key)) return [`${path}: unexpected symbol, accessor or hidden JSON property`];
      const errors = visit(field.value, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
      if (errors.length) return errors;
    }
    seen.delete(node); return [];
  }
  return visit(value, '', 0);
}

/** Compile once before any model dispatch. Unsupported keywords, dialects,
 * unresolved references and async schemas fail startup rather than weakening it.
 */
export function compileResultValidator(schema) {
  try {
    const issues = jsonViolations(schema);
    if (issues.length) throw new Error(issues.join('; '));
    const ajv = new Ajv(options);
    const validate = ajv.compile(schema);
    if (validate.$async) throw new Error('Asynchronous result schemas are unsupported');
    return value => {
      const json = jsonViolations(value); if (json.length) return json;
      if (validate(value)) return [];
      return (validate.errors ?? []).slice(0, 32).map(error => {
        const key = error.keyword === 'additionalProperties' ? `/${error.params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1')}` : '';
        return `${error.instancePath || ''}${key || '/'}: ${error.message}`;
      });
    };
  } catch (cause) {
    const error = new Error('Invalid or unsupported submit_result schema: ' + (cause instanceof Error ? cause.message : 'schema compilation failed'), { cause });
    error.code = 'RESULT_SCHEMA_INVALID'; throw error;
  }
}

/** The same completion lifecycle is used by the native worker and offline tests.
 * Invalid arguments leave delivery active and produce DSH's native tool error;
 * only an accepted result may set finished or call concludeTurn.
 */
export function validatedResultExecution(validate, ToolArgsError, { isActive, complete }) {
  return (args, exec) => {
    if (!isActive(exec)) throw new Error('Delivery is no longer active');
    const violations = validate(args);
    if (violations.length) throw new ToolArgsError(violations);
    return complete(args, exec);
  };
}
