// A small JSON Schema (draft 2020-12) validator for the vendored Agent Plugins schemas, so `npm test`
// needs no dependencies. It fails closed: a schema keyword it does not implement throws, so a schema
// update can never be silently half-checked.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs']);
const IMPLEMENTED = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'const', 'enum', 'pattern',
  'minLength', 'maxLength', 'items', 'minItems', 'maxItems', 'oneOf', '$ref', 'propertyNames', 'not',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => {
    if (node == null || !(key in node)) throw new Error(`Unresolvable $ref: ${ref}`);
    return node[key];
  }, root);
}

/** Returns a list of error strings (empty = valid). */
export function validate(schema, value, root = schema, path = '$') {
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !IMPLEMENTED.has(key)) {
      throw new Error(`json-schema-lite does not implement keyword "${key}" (at schema for ${path})`);
    }
  }
  const errors = [];
  const err = (msg) => errors.push(`${path}: ${msg}`);

  if (schema.$ref) errors.push(...validate(resolveRef(root, schema.$ref), value, root, path));
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(value, t))) {
      err(`expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    err(`must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    err(`must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) err(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err(`does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) err(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) if (!(req in value)) err(`missing required "${req}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, k, root, `${path}{${k}}`));
      if (k in props) errors.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) err(`unexpected property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
      }
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (passing !== 1) err(`must match exactly one schema in oneOf (matched ${passing})`);
  }
  if (schema.not && validate(schema.not, value, root, path).length === 0) err('must not match "not" schema');
  return errors;
}
