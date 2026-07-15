// 最小 JSON Schema 解释器（零依赖），只实现 goal-spec.schema.json 用到的关键字。
// schema 文件是唯一字段规则来源；本解释器不含任何 Goal Spec 字段知识（V7）。
// 支持：type、const、enum、pattern、minLength/maxLength、minimum/maximum、
//       properties、required、additionalProperties(false)、items、minItems/maxItems、anyOf。

export function validateSchema(value, schema, path = '$') {
  const errors = [];

  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => validateSchema(value, sub, path).length === 0);
    if (!ok) errors.push({ path, message: '不满足任一允许的形态' });
    return errors;
  }

  if ('const' in schema && value !== schema.const) {
    errors.push({ path, message: `必须等于 ${JSON.stringify(schema.const)}` });
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `必须是以下之一：${schema.enum.join('、')}` });
    return errors;
  }

  if (schema.type) {
    if (!typeMatches(value, schema.type)) {
      errors.push({ path, message: `类型应为 ${schema.type}` });
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `长度不得小于 ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `长度不得大于 ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `不匹配模式 ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `不得小于 ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `不得大于 ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `至少需要 ${schema.minItems} 项` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `最多允许 ${schema.maxItems} 项` });
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(...validateSchema(item, schema.items, `${path}[${idx}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path, message: `缺少必填字段 ${key}` });
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (key in props) {
        errors.push(...validateSchema(v, props[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: '未知字段（schema 不允许额外字段）' });
      }
    }
  }

  return errors;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}
