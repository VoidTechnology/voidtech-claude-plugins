// 严格 YAML 子集解析器，Goal Spec 专用（零依赖）。
// 支持：块映射、块序列、flow 序列、单/双引号字符串、纯量（字符串/整数/布尔/null）、注释。
// 拒绝：锚点/别名/标签、多文档、块标量（| >）、flow 映射（{}）、tab 缩进、重复键、含 ": " 的裸纯量。
// 拒绝集是刻意的：Goal Spec 是验收契约，宁可让作者加引号，也不引入歧义解析。

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `第 ${line} 行：${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

export function parseYaml(text) {
  const rawLines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const lines = [];
  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    if (/^\s*$/.test(raw)) continue;
    const leading = raw.match(/^[ \t]*/)[0];
    if (leading.includes('\t')) throw new YamlError('缩进不允许使用 tab', n + 1);
    const content = raw.slice(leading.length);
    if (content.startsWith('#')) continue;
    if (/^(---|\.\.\.)(\s|$)/.test(content)) throw new YamlError('不支持多文档分隔符', n + 1);
    lines.push({ indent: leading.length, content, line: n + 1 });
  }
  if (lines.length === 0) throw new YamlError('空文档');
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new YamlError(`存在无法归属的内容：${lines[next].content}`, lines[next].line);
  }
  return value;
}

function isSeqItem(content) {
  return content === '-' || content.startsWith('- ');
}

function parseBlock(lines, i, indent) {
  if (lines[i].indent !== indent) {
    throw new YamlError('缩进与所属块不一致', lines[i].line);
  }
  return isSeqItem(lines[i].content) ? parseSeq(lines, i, indent) : parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length && lines[i].indent === indent && !isSeqItem(lines[i].content)) {
    const { content, line } = lines[i];
    const m = content.match(/^([A-Za-z0-9_-]+):(?:[ ](.*))?$/);
    if (!m) throw new YamlError(`无法解析的映射行：${content}`, line);
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new YamlError(`重复键：${key}`, line);
    }
    const rest = stripComment(m[2] ?? '', line).trim();
    i++;
    if (rest !== '') {
      obj[key] = parseScalarOrFlow(rest, line);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, next] = parseBlock(lines, i, lines[i].indent);
      obj[key] = v;
      i = next;
    } else {
      obj[key] = null;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError('缩进错误：出现比所属块更深的孤立行', lines[i].line);
  }
  return [obj, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i].content)) {
    const { content, line } = lines[i];
    const rest = stripComment(content === '-' ? '' : content.slice(2), line).trim();
    if (rest === '') {
      i++;
      if (i < lines.length && lines[i].indent > indent) {
        const [v, next] = parseBlock(lines, i, lines[i].indent);
        arr.push(v);
        i = next;
      } else {
        arr.push(null);
      }
    } else if (/^[A-Za-z0-9_-]+:([ ]|$)/.test(rest)) {
      const keyIndent = indent + (content.length - content.slice(2).trimStart().length - 2) + 2;
      const window = [{ indent: keyIndent, content: rest, line }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= keyIndent) {
        window.push(lines[j]);
        j++;
      }
      const [v, consumed] = parseMap(window, 0, keyIndent);
      if (consumed !== window.length) {
        throw new YamlError('序列项内存在无法归属的内容', window[consumed].line);
      }
      arr.push(v);
      i = j;
    } else {
      arr.push(parseScalarOrFlow(rest, line));
      i++;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError('缩进错误：出现比所属块更深的孤立行', lines[i].line);
  }
  return [arr, i];
}

// 剥离行尾注释：仅当 "#" 前是空白且不在引号内时生效。
function stripComment(s, line) {
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (quote === '"' && c === '\\') k++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && k > 0 && (s[k - 1] === ' ' || s[k - 1] === '\t')) {
      return s.slice(0, k);
    }
  }
  if (quote) throw new YamlError('引号未闭合', line);
  return s;
}

function parseScalarOrFlow(s, line) {
  if (s.startsWith('[')) return parseFlowSeq(s, line);
  return parseScalar(s, line);
}

function parseFlowSeq(s, line) {
  if (!s.endsWith(']')) throw new YamlError('flow 序列未以 ] 结束', line);
  const body = s.slice(1, -1).trim();
  if (body === '') return [];
  const parts = [];
  let cur = '';
  let quote = null;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\') { cur += body[++k] ?? ''; }
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '[' || c === '{') {
      throw new YamlError('flow 序列不支持嵌套集合', line);
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    if (t === '') throw new YamlError('flow 序列包含空元素', line);
    return parseScalar(t, line);
  });
}

function parseScalar(s, line) {
  const first = s[0];
  if ('&*!|>{'.includes(first)) {
    throw new YamlError(`不支持的 YAML 语法（锚点/别名/标签/块标量/flow 映射）：${s}`, line);
  }
  if (first === "'") {
    if (s.length < 2 || !s.endsWith("'") || s.slice(1, -1).includes("'")) {
      throw new YamlError('单引号字符串格式错误（不支持内嵌引号）', line);
    }
    return s.slice(1, -1);
  }
  if (first === '"') {
    return parseDoubleQuoted(s, line);
  }
  if (s.includes(': ')) {
    throw new YamlError(`裸纯量包含 ": "，存在歧义，请加引号：${s}`, line);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw new YamlError(`整数超出安全范围：${s}`, line);
    return n;
  }
  return s;
}

function parseDoubleQuoted(s, line) {
  if (s.length < 2 || !s.endsWith('"')) throw new YamlError('双引号字符串未闭合', line);
  const body = s.slice(1, -1);
  let out = '';
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '"') throw new YamlError('双引号字符串包含未转义引号', line);
    if (c === '\\') {
      const e = body[++k];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === '"') out += '"';
      else if (e === '\\') out += '\\';
      else throw new YamlError(`不支持的转义序列：\\${e ?? ''}`, line);
    } else {
      out += c;
    }
  }
  return out;
}
