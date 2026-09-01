export type JsonSchema = boolean | Record<string, unknown>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function joinPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path === '$' ? `$.${key}` : `${path}.${key}`;
}

/** Small strict JSON Schema validator for tool inputs. */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (schema === true) return null;
  if (schema === false) return `${path} is not allowed`;

  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf as JsonSchema[] : undefined;
  if (alternatives) {
    const matches = alternatives.filter((candidate) => validateJsonSchema(value, candidate, path) === null);
    if (matches.length === 1) return null;
    return matches.length === 0
      ? `${path} does not match any supported input shape`
      : `${path} matches more than one input shape`;
  }

  if ('const' in schema && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
    return `${path} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`;
  }

  const expected = typeof schema.type === 'string' ? schema.type : undefined;
  if (expected) {
    const actual = valueType(value);
    const valid = expected === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : actual === expected;
    if (!valid) return `${path} must be ${expected}`;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path} must contain at least ${schema.minLength} characters`;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path} must contain at most ${schema.maxLength} characters`;
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
      } catch {
        return `${path} uses an invalid schema pattern`;
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchema(value[index], schema.items as JsonSchema, joinPath(path, index));
        if (error) return error;
      }
    }
  }

  const object = objectValue(value);
  if (object) {
    const properties = objectValue(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const key of required) if (!(key in object)) return `${joinPath(path, key)} is required`;
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties));
      if (unknown) return `${joinPath(path, unknown)} is not supported`;
    }
    for (const [key, entry] of Object.entries(object)) {
      const propertySchema = properties[key];
      if (propertySchema === undefined) continue;
      const error = validateJsonSchema(entry, propertySchema as JsonSchema, joinPath(path, key));
      if (error) return error;
    }
  }

  return null;
}
