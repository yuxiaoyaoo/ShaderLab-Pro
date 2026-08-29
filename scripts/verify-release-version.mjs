import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const tag = (process.env.RELEASE_TAG ?? process.argv[2] ?? '').trim();

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`RELEASE_TAG 必须是 v 开头的 semver，当前值：${tag || '<empty>'}`);
}

const expected = tag.slice(1);
const packageVersion = JSON.parse(read('package.json')).version;
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoVersion = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = {
  'package.json': packageVersion,
  'src-tauri/tauri.conf.json': tauriConfig.version,
  'src-tauri/Cargo.toml': cargoVersion,
};
const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
if (mismatches.length) {
  throw new Error(`发布标签 ${tag} 与应用版本不一致：${mismatches.map(([file, version]) => `${file}=${version ?? '<missing>'}`).join(', ')}`);
}

const endpoint = tauriConfig.plugins?.updater?.endpoints?.[0];
if (typeof endpoint !== 'string' || endpoint.includes('OWNER/REPO') || !endpoint.endsWith('/releases/latest/download/latest.json')) {
  throw new Error(`Updater endpoint 无效：${String(endpoint)}`);
}

const workflow = read('.github/workflows/release.yml');
if (!workflow.includes('includeUpdaterJson: true') || workflow.includes('publishUpdaterJson: true')) {
  throw new Error('release workflow 必须使用 includeUpdaterJson: true');
}

console.log(`Release version gate passed: ${tag}`);
