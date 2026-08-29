import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.map']);
const forbidden = [
  'SLP_UPDATER_DEV_SIMULATION',
  'SLP_UPDATER_DEV_SIMULATION_FAILURE',
  '9.9.9-dev-simulated',
];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(dist).filter((file) => textExtensions.has(extname(file)));
assert.ok(files.length > 0, 'dist 中没有可检查的 production 文本产物；请先运行 npm run build');

const leaks = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const sentinel of forbidden) {
    if (content.includes(sentinel)) leaks.push(`${file}: ${sentinel}`);
  }
}
assert.deepEqual(leaks, [], `DEV updater 模拟标记泄漏到 production bundle：\n${leaks.join('\n')}`);
console.log(`Production bundle guard passed: ${files.length} files, ${forbidden.length} forbidden sentinels absent.`);
