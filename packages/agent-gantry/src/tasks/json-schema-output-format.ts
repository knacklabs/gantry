import { asRecord } from '../shared/helpers.js';

const SUPPORTED_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

export function buildCompatibleJsonSchema(
  schema: Record<string, unknown> | undefined,
  limits: {
    readonly optionalParameters: number;
    readonly unionParameters: number;
  },
): Record<string, unknown> | null {
  if (schema?.type !== 'object' || hasOpenObjectSchema(schema)) return null;
  try {
    const transformed = transformSchema(schema);
    const complexity = countComplexity(transformed);
    return complexity.optionalParameters <= limits.optionalParameters &&
      complexity.unionParameters <= limits.unionParameters
      ? transformed
      : null;
  } catch {
    return null;
  }
}

function transformSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.$ref === 'string') return { $ref: schema.$ref };
  const transformed: Record<string, unknown> = {};
  const definitions = asRecord(schema.$defs);
  if (definitions) {
    transformed.$defs = Object.fromEntries(
      Object.entries(definitions).map(([key, value]) => {
        const definition = asRecord(value);
        if (!definition) throw new Error('Invalid JSON schema definition.');
        return [key, transformSchema(definition)];
      }),
    );
  }
  const anyOf = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (anyOf) {
    transformed.anyOf = transformVariants(anyOf);
  } else if (Array.isArray(schema.allOf)) {
    transformed.allOf = transformVariants(schema.allOf);
  } else if (schema.type !== undefined) {
    transformed.type = schema.type;
  } else {
    throw new Error('JSON schema type is required.');
  }
  if (typeof schema.title === 'string') transformed.title = schema.title;
  if (typeof schema.description === 'string') transformed.description = schema.description;
  if (Array.isArray(schema.enum)) transformed.enum = schema.enum;
  if ('const' in schema) transformed.const = schema.const;

  const handled = new Set([
    '$defs', '$ref', 'type', 'anyOf', 'oneOf', 'allOf', 'title', 'description',
    'enum', 'const',
  ]);
  if (schema.type === 'object') {
    const properties = asRecord(schema.properties) ?? {};
    transformed.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const property = asRecord(value);
        if (!property) throw new Error('Invalid JSON schema property.');
        return [key, transformSchema(property)];
      }),
    );
    transformed.additionalProperties = false;
    if (Array.isArray(schema.required)) transformed.required = schema.required;
    handled.add('properties');
    handled.add('additionalProperties');
    handled.add('required');
  } else if (schema.type === 'array') {
    const items = asRecord(schema.items);
    if ('items' in schema && !items) throw new Error('Invalid JSON schema items.');
    if (items) transformed.items = transformSchema(items);
    if (schema.minItems === 0 || schema.minItems === 1) {
      transformed.minItems = schema.minItems;
      handled.add('minItems');
    }
    handled.add('items');
  } else if (schema.type === 'string') {
    if (
      typeof schema.format === 'string' &&
      SUPPORTED_STRING_FORMATS.has(schema.format)
    ) {
      transformed.format = schema.format;
      handled.add('format');
    }
  }
  const constraints = Object.entries(schema).filter(([key]) => !handled.has(key));
  if (constraints.length > 0) {
    const prefix = typeof transformed.description === 'string'
      ? `${transformed.description}\n\n`
      : '';
    transformed.description = `${prefix}{${constraints
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')}}`;
  }
  return transformed;
}

function transformVariants(variants: readonly unknown[]): Record<string, unknown>[] {
  return variants.map((value) => {
    const variant = asRecord(value);
    if (!variant) throw new Error('Invalid JSON schema variant.');
    return transformSchema(variant);
  });
}

function hasOpenObjectSchema(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.type) && schema.type.includes('object')) return true;
  if (schema.type === 'object') {
    const properties = asRecord(schema.properties);
    if (
      schema.additionalProperties === true ||
      (!properties && schema.additionalProperties !== false)
    ) {
      return true;
    }
    if (properties && Object.values(properties).some(isOpenObjectValue)) return true;
  }
  if (isOpenObjectValue(schema.items)) return true;
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[keyword]) && schema[keyword].some(isOpenObjectValue)) {
      return true;
    }
  }
  const definitions = asRecord(schema.$defs);
  return Boolean(definitions && Object.values(definitions).some(isOpenObjectValue));
}

function isOpenObjectValue(value: unknown): boolean {
  const schema = asRecord(value);
  return schema ? hasOpenObjectSchema(schema) : false;
}

function countComplexity(schema: Record<string, unknown>): {
  readonly optionalParameters: number;
  readonly unionParameters: number;
} {
  const properties = asRecord(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  let optionalParameters = properties
    ? Object.keys(properties).filter((key) => !required.has(key)).length
    : 0;
  let unionParameters = Array.isArray(schema.type) ? 1 : 0;
  const children: unknown[] = [
    ...(properties ? Object.values(properties) : []),
    ...(asRecord(schema.$defs) ? Object.values(asRecord(schema.$defs)!) : []),
    ...(asRecord(schema.items) ? [schema.items] : []),
  ];
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = Array.isArray(schema[keyword]) ? schema[keyword] : [];
    if ((keyword === 'anyOf' || keyword === 'oneOf') && variants.length > 0) {
      unionParameters += 1;
    }
    children.push(...variants);
  }
  for (const child of children) {
    const childSchema = asRecord(child);
    if (!childSchema) continue;
    const childComplexity = countComplexity(childSchema);
    optionalParameters += childComplexity.optionalParameters;
    unionParameters += childComplexity.unionParameters;
  }
  return { optionalParameters, unionParameters };
}
