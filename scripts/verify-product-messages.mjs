import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import {
  MESSAGE_KEYS,
  isKnownProductMessageCode,
} from '../src/productMessageFormatter.ts';
import { translationCatalogs } from '../src/i18n.ts';
import { sanitizeProductMessageDetail } from '../src/productMessageDetail.ts';

const root = resolve(import.meta.dirname, '..');
const sourceRoots = [join(root, 'src'), join(root, 'src-tauri', 'src')];
const sourceExtensions = new Set(['.ts', '.tsx', '.rs']);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : sourceExtensions.has(extname(entry.name))
        ? [path]
        : [];
  });
}

function placeholders(template) {
  return [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

const zh = translationCatalogs['zh-CN'];
const en = translationCatalogs.en;
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英文翻译 key 必须完全一致');

for (const key of Object.keys(zh)) {
  assert.deepEqual(
    placeholders(zh[key]),
    placeholders(en[key]),
    `中英文占位符不一致：${key}`,
  );
}

for (const [code, key] of Object.entries(MESSAGE_KEYS)) {
  assert.equal(isKnownProductMessageCode(code), true, `已知 ProductMessage code 未通过类型守卫：${code}`);
  assert.ok(Object.hasOwn(zh, key), `ProductMessage 缺少中文翻译：${code} -> ${key}`);
  assert.ok(Object.hasOwn(en, key), `ProductMessage 缺少英文翻译：${code} -> ${key}`);
}
assert.equal(isKnownProductMessageCode('wire.future-unknown-code'), false, '未知 wire code 不应被识别为已知 code');

const literalCodes = new Map();
const codePattern = /\bcode\s*:\s*(['"])([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)\1/g;
const files = sourceRoots.flatMap(walk);
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(codePattern)) {
    const locations = literalCodes.get(match[2]) ?? [];
    locations.push(`${relative(root, file)}:${source.slice(0, match.index).split(/\r?\n/).length}`);
    literalCodes.set(match[2], locations);
  }
}

const unmapped = [...literalCodes]
  .filter(([code]) => !isKnownProductMessageCode(code))
  .map(([code, locations]) => `${code} (${locations.join(', ')})`);
assert.deepEqual(unmapped, [], `发现没有精确 i18n 映射的 ProductMessage code：\n${unmapped.join('\n')}`);

const productBoundaryFiles = files.filter((file) => {
  const path = relative(root, file).replaceAll('\\', '/');
  return path === 'src/App.tsx'
    || path.startsWith('src/components/')
    || path.startsWith('src/export/')
    || path.startsWith('src/agent/')
    || path.startsWith('src/updater/');
});
const fixedErrorPattern = /(?:throw\s+)?new\s+Error\s*\(\s*(?:['"`]|t\s*\()/g;
const forbiddenErrors = [];
for (const file of productBoundaryFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(fixedErrorPattern)) {
    const prefix = source.slice(Math.max(0, match.index - 180), match.index);
    if (prefix.includes('product-message-guard: allow')) continue;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    forbiddenErrors.push(`${relative(root, file)}:${line}`);
  }
}
assert.deepEqual(
  forbiddenErrors,
  [],
  `用户可达边界不得用固定字符串或 t(...) 构造裸 Error；请改用 ProductError，或为开发期不变量添加显式 allow 注释：\n${forbiddenErrors.join('\n')}`,
);

const sensitiveFixture = [
  'Authorization: Bearer top-secret-token',
  'api_key=sk-proj-abcdefghijklmnop',
  'https://user:password@example.com/path?token=secret#private',
  'C:\\Users\\Alice\\project\\shader.glsl',
  '/home/bob/project/shader.glsl',
  `safe\u202Etext`,
  ...Array.from({ length: 45 }, (_, index) => `line ${index}`),
].join('\n');
const safeFixture = sanitizeProductMessageDetail(sensitiveFixture);
assert.equal(safeFixture.redacted, true, '敏感详情必须标记为已脱敏');
assert.equal(safeFixture.truncated, true, '超限详情必须标记为已截断');
for (const secret of ['top-secret-token', 'sk-proj-abcdefghijklmnop', 'password', 'Alice', 'bob', '\u202E']) {
  assert.equal(safeFixture.text.includes(secret), false, `脱敏结果仍包含敏感值：${JSON.stringify(secret)}`);
}

console.log(
  `Product message guard passed: ${Object.keys(MESSAGE_KEYS).length} codes, ${Object.keys(zh).length} bilingual keys, ${literalCodes.size} literal producers.`,
);
