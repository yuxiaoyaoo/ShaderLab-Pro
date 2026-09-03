import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 src/shadertoy/runtime.ts 的 FRAG_HEADER / FRAG_FOOTER 完全一致
const header = [
  '#version 300 es',
  'precision highp float;',
  '#define HW_PERFORMANCE 0',
  '',
  'uniform vec3 iResolution;',
  'uniform float iTime;',
  'uniform float iTimeDelta;',
  'uniform int iFrame;',
  'uniform vec4 iMouse;',
  'uniform vec4 iDate;',
  'uniform float iSampleRate;',
  'uniform sampler2D iChannel0;',
  'uniform sampler2D iChannel1;',
  'uniform sampler2D iChannel2;',
  'uniform sampler2D iChannel3;',
  'uniform vec3 iChannelResolution[4];',
  '',
  'out vec4 outColor;',
  '',
];
const footer = ['', 'void main() {', '    mainImage(outColor, gl_FragCoord.xy);', '}'];

const raw = fs.readFileSync('F:/ShaderLab Pro/code.txt', 'utf8');
const userLines = raw.split('\n');
const userLinesNoCr = raw.replace(/\r\n/g, '\n').split('\n');

const fullOf = (lines) => [...header, ...lines, ...footer].join('\n');

const sources = {
  A_exact_like_app: fullOf(userLines),
  B_no_copyright_sign: fullOf(userLines.map((l) => l.replace('©', '(c)'))),
  C_with_HW_PERFORMANCE_define: fullOf(['#define HW_PERFORMANCE 0', ...userLines]),
  G_no_cr: fullOf(userLinesNoCr),
  D_mini_undef_macro: [
    '#version 300 es',
    'precision highp float;',
    '#if HW_PERFORMANCE==0',
    '#define AA 1',
    '#else',
    '#define AA 2',
    '#endif',
    'out vec4 o;',
    'void main() { o = vec4(float(AA)); }',
  ].join('\n'),
  E_mini_nonascii_comment: [
    '#version 300 es',
    'precision highp float;',
    '// Copyright © 2013',
    'out vec4 o;',
    'void main() { o = vec4(1.0); }',
  ].join('\n'),
  // iKeyboard compile variant: reads the 256x2 keyboard data texture bound to
  // iChannel0 (row 0 = pressed-this-frame pulse, row 1 = currently held).
  F_ikeyboard_texel_fetch: [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D iChannel0;',
    'out vec4 o;',
    'void main() {',
    '    float held = texelFetch(iChannel0, ivec2(65, 1), 0).x;',
    '    float pulse = texelFetch(iChannel0, ivec2(65, 0), 0).x;',
    '    o = vec4(held, pulse, 0.0, 1.0);',
    '}',
  ].join('\n'),
  // Same read through the app's real header (texture2D path used by user code).
  G_ikeyboard_via_header: fullOf([
    'void mainImage(out vec4 o, vec2 uv) {',
    '    float held = texelFetch(iChannel0, ivec2(65, 1), 0).x;',
    '    o = vec4(held, 0.0, 0.0, 1.0);',
    '}',
  ]),
};

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edge = candidates.find((p) => fs.existsSync(p));
if (!edge) {
  console.error('msedge.exe not found');
  process.exit(1);
}

const dataDir = path.join(os.tmpdir(), 'edge-cdp-repro');
fs.rmSync(dataDir, { recursive: true, force: true });
const proc = spawn(edge, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${dataDir}`,
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });

async function waitTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP target timeout');
}

const target = await waitTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});
const send = (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP ${method} timeout`));
  }, timeoutMs);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});

const expression = `(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return { ctxError: 'no webgl2' };
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { renderer = 'unknown'; }
  const sources = ${JSON.stringify(sources)};
  const results = {};
  for (const [name, src] of Object.entries(sources)) {
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    let log = '';
    try { log = gl.getShaderInfoLog(sh) || ''; } catch (e) { log = String(e); }
    results[name] = { ok, log };
    gl.deleteShader(sh);
  }
  return { renderer, userLineOffset: ${header.length}, results };
})()`;

const res = await send('Runtime.evaluate', { expression, returnByValue: true });
if (res.exceptionDetails) {
  console.error('evaluate exception:', JSON.stringify(res.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(res.result.value, null, 2));
}

ws.close();
proc.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
