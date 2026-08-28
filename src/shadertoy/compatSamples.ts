export interface CompatSample {
  id: string;
  name: string;
  expectFail?: boolean;
  image: string;
  common?: string;
  buffers?: { id: string; src: string; feedback?: boolean }[];
  imageChannels?: { index: number; src: string }[];
  sound?: string;
}

const UV = 'vec2 uv = f / iResolution.xy;';

const GOOD: CompatSample[] = [
  {
    id: 'flat',
    name: '纯色',
    image: `void mainImage(out vec4 o, in vec2 f) { o = vec4(0.25, 0.5, 0.75, 1.0); }`,
  },
  {
    id: 'gradient',
    name: '渐变',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} o = vec4(uv, 0.5, 1.0); }`,
  },
  {
    id: 'vstripes',
    name: '竖条纹',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float v = step(0.5, fract(uv.x * 12.0)); o = vec4(v); }`,
  },
  {
    id: 'hstripes',
    name: '横条纹',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float v = step(0.5, fract(uv.y * 12.0)); o = vec4(v); }`,
  },
  {
    id: 'checker',
    name: '棋盘格',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 g = step(vec2(0.5), fract(uv * 8.0)); o = vec4(vec3(step(0.5, g.x + g.y - g.x * g.y)), 1.0); }`,
  },
  {
    id: 'circle',
    name: '圆盘',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float d = length(uv - 0.5); o = vec4(vec3(step(d, 0.2)), 1.0); }`,
  },
  {
    id: 'ring',
    name: '圆环',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float d = abs(length(uv - 0.5) - 0.3); o = vec4(vec3(step(d, 0.03)), 1.0); }`,
  },
  {
    id: 'diamond',
    name: '菱形',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 c = abs(uv - 0.5); float d = c.x + c.y; o = vec4(vec3(step(d, 0.3)), 1.0); }`,
  },
  {
    id: 'grid',
    name: '网格线',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 g = abs(fract(uv * 16.0 - 0.5) - 0.5) / fwidth(uv * 16.0); float l = 1.0 - min(min(g.x, g.y), 1.0); o = vec4(vec3(l) * 0.8, 1.0); }`,
  },
  {
    id: 'fade',
    name: '双色过渡',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec3 a = vec3(0.9, 0.2, 0.2); vec3 b = vec3(0.2, 0.4, 0.9); o = vec4(mix(a, b, uv.x), 1.0); }`,
  },
  {
    id: 'blink',
    name: '闪烁',
    image: `void mainImage(out vec4 o, in vec2 f) { float v = 0.5 + 0.5 * sin(iTime * 4.0); o = vec4(vec3(v), 1.0); }`,
  },
  {
    id: 'bounce',
    name: '弹跳光球',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 p = vec2(0.5 + 0.3 * sin(iTime), 0.5 + 0.3 * cos(iTime * 1.3)); float d = length(uv - p); o = vec4(vec3(0.3 / (d + 0.05)), 1.0); }`,
  },
  {
    id: 'hashfield',
    name: '哈希场',
    image: `float hash21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
void mainImage(out vec4 o, in vec2 f) { ${UV} o = vec4(hash21(floor(uv * 24.0)), 0.2, 0.3, 1.0); }`,
  },
  {
    id: 'vnoise2d',
    name: '双线性噪声',
    image: `float hash21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y); }
void mainImage(out vec4 o, in vec2 f) { ${UV} o = vec4(vec3(vnoise(uv * 7.0)), 1.0); }`,
  },
  {
    id: 'fbmcloud',
    name: 'FBM 云',
    image: `float hash21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; } return v; }
void mainImage(out vec4 o, in vec2 f) { ${UV} float n = fbm(uv * 4.0 + iTime * 0.1); o = vec4(vec3(n * 0.9, n * 0.6, n * 0.4), 1.0); }`,
  },
  {
    id: 'mandelbrot',
    name: '曼德博',
    image: `float mandel(vec2 z0) { vec2 z = z0; for (int i = 0; i < 64; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + z0; if (dot(z, z) > 4.0) return float(i); } return 64.0; }
void mainImage(out vec4 o, in vec2 f) { ${UV} float it = mandel((uv - 0.5) * 3.0); o = vec4(vec3(0.5 + 0.5 * cos(it * 0.4)), 1.0); }`,
  },
  {
    id: 'julia',
    name: '茱莉亚',
    image: `float julia(vec2 z0) { vec2 z = z0; for (int i = 0; i < 64; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + vec2(-0.7, 0.27); if (dot(z, z) > 4.0) return float(i); } return 64.0; }
void mainImage(out vec4 o, in vec2 f) { ${UV} float it = julia((uv - 0.5) * 3.0); o = vec4(vec3(0.5 * sin(it * 0.3) + 0.5), 1.0); }`,
  },
  {
    id: 'plasma',
    name: '等离子体',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float v = sin(uv.x * 10.0 + iTime) + sin(uv.y * 8.0 - iTime * 1.3) + sin((uv.x + uv.y) * 6.0 + iTime * 0.7); v = v * 0.25 + 0.5; o = vec4(vec3(v), 1.0); }`,
  },
  {
    id: 'tunnel',
    name: '隧道',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 c = uv - 0.5; float r = length(c); float a = atan(c.y, c.x); float t = fract(iTime * 0.3 + r * 4.0); o = vec4(vec3(step(0.5, fract(t + a * 8.0)) * (1.0 - r)), 1.0); }`,
  },
  {
    id: 'starfield',
    name: '星空',
    image: `float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(out vec4 o, in vec2 f) { ${UV} float h = hash12(floor(uv * 40.0)); float s = step(0.97, h); o = vec4(vec3(s) * 1.2, 1.0); }`,
  },
  {
    id: 'domainwarp',
    name: '域扭曲',
    image: `float hash21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; } return v; }
void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 p = uv * 3.0; float n = fbm(p + fbm(p + iTime * 0.2) * 1.5); o = vec4(vec3(n), 1.0); }`,
  },
  {
    id: 'uvcenter',
    name: '居中 UV',
    image: `void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float d = length(uv); o = vec4(vec3(step(d, 0.8)), 1.0); }`,
  },
  {
    id: 'rotsquare',
    name: '旋转方块',
    image: `mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; uv = rot2(iTime * 0.8) * uv; float d = max(abs(uv.x), abs(uv.y)); o = vec4(vec3(step(d, 0.3)), 1.0); }`,
  },
  {
    id: 'polar',
    name: '极坐标圆盘',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 c = uv - 0.5; float r = length(c); float a = atan(c.y, c.x) / 6.28318 + 0.5; o = vec4(fract(vec3(a, r * 10.0, 1.0)), 1.0); }`,
  },
  {
    id: 'palette',
    name: '调色板',
    image: `vec3 pal(float t) { vec3 a = vec3(0.5); vec3 b = vec3(0.5); vec3 c = vec3(1.0); vec3 d = vec3(0.263, 0.416, 0.557); return a + b * cos(6.28318 * (c * t + d)); }
void mainImage(out vec4 o, in vec2 f) { ${UV} o = vec4(pal(uv.x + 0.5 * sin(iTime)), 1.0); }`,
  },
  {
    id: 'triwave',
    name: '三角波',
    image: `float tri(float t) { return abs(fract(t) * 2.0 - 1.0); }
void mainImage(out vec4 o, in vec2 f) { ${UV} o = vec4(vec3(tri(uv.x * 6.0 + iTime)), 1.0); }`,
  },
  {
    id: 'stepped',
    name: '阶梯量化',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec3 c = vec3(uv.x * 8.0, uv.y * 8.0, 1.0); c = floor(c) / 8.0; o = vec4(c, 1.0); }`,
  },
  {
    id: 'aaedge',
    name: '反走样边缘',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float d = length(uv - 0.5) - 0.2; float v = smoothstep(2.0 / iResolution.x, -2.0 / iResolution.x, d); o = vec4(vec3(v), 1.0); }`,
  },
  {
    id: 'mirror',
    name: '镜像对称',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 m = abs(uv - 0.5); o = vec4(vec3(m.x, m.y, 0.5), 1.0); }`,
  },
  {
    id: 'sdfcircle',
    name: 'SDF 圆',
    image: `float sdCircle(vec2 p, float r) { return length(p) - r; }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float d = sdCircle(uv, 0.55); float v = 1.0 - smoothstep(1.0 / iResolution.y, -1.0 / iResolution.y, d); o = vec4(vec3(v * 0.8), 1.0); }`,
  },
  {
    id: 'sdfround',
    name: 'SDF 圆角矩形',
    image: `float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float d = sdRound(uv, vec2(0.4, 0.25), 0.12); o = vec4(vec3(1.0 - smoothstep(1.0 / iResolution.y, -1.0 / iResolution.y, d)), 1.0); }`,
  },
  {
    id: 'sdfline',
    name: 'SDF 线段',
    image: `float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a; vec2 ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float d = sdSeg(uv, vec2(-0.5, -0.3), vec2(0.5, 0.3)); o = vec4(vec3(1.0 - smoothstep(1.0 / iResolution.y, -1.0 / iResolution.y, d)), 1.0); }`,
  },
  {
    id: 'sdfring',
    name: 'SDF 环',
    image: `float sdCircle(vec2 p, float r) { return length(p) - r; }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float d = abs(sdCircle(uv, 0.5)) - 0.06; o = vec4(vec3(1.0 - smoothstep(1.0 / iResolution.y, -1.0 / iResolution.y, d)), 1.0); }`,
  },
  {
    id: 'glowblobs',
    name: '光晕团',
    image: `void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; vec3 col = vec3(0.0); for (float i = 0.0; i < 5.0; i++) { vec2 c = vec2(sin(iTime * 0.6 + i * 2.1), cos(iTime * 0.9 + i * 1.3)) * 0.5; col += 0.1 / length(uv - c) * vec3(0.4 + 0.6 * sin(i + iTime), 0.5, 0.6); } o = vec4(col, 1.0); }`,
  },
  {
    id: 'rays',
    name: '光芒',
    image: `void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float a = atan(uv.y, uv.x); float r = length(uv); float v = 0.5 + 0.5 * sin(a * 12.0 + iTime * 2.0); o = vec4(vec3(v * (0.35 / (r + 0.35))), 1.0); }`,
  },
  {
    id: 'oldtv',
    name: '老电视',
    image: `float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(out vec4 o, in vec2 f) { ${UV} float scan = 0.8 + 0.2 * sin(uv.y * iResolution.y * 6.28318); float n = hash12(f + vec2(iTime * 30.0, 0.0)) * 0.1; o = vec4(vec3(uv.x * scan + n, uv.y * scan + n, 0.5 + n), 1.0); }`,
  },
  {
    id: 'waves',
    name: '波浪',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float w = sin(uv.x * 20.0 - iTime * 3.0) * 0.1; float d = abs(uv.y - 0.5 + w); o = vec4(vec3(1.0 - step(0.02, d) * smoothstep(0.02, 0.08, d)), 1.0); }`,
  },
  {
    id: 'fire',
    name: '伪火',
    image: `float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(out vec4 o, in vec2 f) { ${UV} float v = hash12(vec2(uv.x * 8.0, fract(iTime * 0.5) + uv.y * 8.0)); o = vec4(vec3(v, v * 0.5, v * 0.2), 1.0); }`,
  },
  {
    id: 'mountains',
    name: '群山',
    image: `float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(out vec4 o, in vec2 f) { ${UV} float h = 0.0; for (int i = 0; i < 4; i++) { float ii = float(i); h += hash12(vec2(ii, floor(uv.x * (6.0 + ii)))) * (0.25 + 0.2 * sin(iTime + ii)); } float sky = step(uv.y, h); o = vec4(mix(vec3(0.3, 0.6, 0.9), vec3(0.2, 0.4, 0.2), sky), 1.0); }`,
  },
  {
    id: 'liquid',
    name: '液态',
    image: `float hash21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y); }
void mainImage(out vec4 o, in vec2 f) { vec2 uv = (2.0 * f - iResolution.xy) / iResolution.y; float a = vnoise(uv * 3.0 + vec2(iTime * 0.4, 0.0)); o = vec4(vec3(0.0, 0.5 + 0.5 * a, 0.8 - 0.3 * a), 1.0); }`,
  },
  {
    id: 'spiral',
    name: '螺旋',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 c = uv - 0.5; float a = atan(c.y, c.x) / 6.28318 + 0.5; float r = length(c); float t = fract(a * 3.0 + r * 8.0 - iTime * 0.5); o = vec4(vec3(smoothstep(0.0, 0.4, t) - smoothstep(0.4, 0.6, t)), 1.0); }`,
  },
  {
    id: 'hyperspace',
    name: '超空间',
    image: `float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(out vec4 o, in vec2 f) { ${UV} vec2 c = uv - 0.5; float a = atan(c.y, c.x); float r = length(c); float h = hash12(floor(vec2(a * 24.0, 0.0)) + vec2(0.0, floor(iTime * 5.0))); float streak = step(0.98, h) * exp(-r * 6.0); o = vec4(vec3(streak), 1.0); }`,
  },
  {
    id: 'buf-in',
    name: '缓冲通道（图像采样 Buffer A）',
    image: `void mainImage(out vec4 o, in vec2 f) { vec4 t = texture(iChannel0, f / iResolution.xy); o = vec4(t.rgb, 1.0); }`,
    buffers: [{ id: 'bufferA', src: `void mainImage(out vec4 o, in vec2 f) { o = vec4(0.4, 0.2, 0.9, 1.0); }` }],
    imageChannels: [{ index: 0, src: 'bufferA' }],
  },
  {
    id: 'buf-feedback',
    name: '反馈累积',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} vec4 t = texture(iChannel0, uv); o = vec4(t.rgb + 0.004, 1.0); }`,
    buffers: [{ id: 'bufferA', src: `void mainImage(out vec4 o, in vec2 f) { vec4 t = texture(iChannel0, f / iResolution.xy); o = vec4(t.r + 0.004, t.g, t.b + 0.002, 1.0); }`, feedback: true }],
    imageChannels: [{ index: 0, src: 'bufferA' }],
  },
  {
    id: 'sound-sync',
    name: '音画同步',
    image: `void mainImage(out vec4 o, in vec2 f) { ${UV} float v = 0.5 + 0.5 * sin(uv.x * 20.0 - iTime * 8.0); o = vec4(vec3(v), 1.0); }`,
    sound: `vec2 mainSound(int samp, float time) { return vec2(0.4 * sin(0.01 * float(samp))); }`,
  },
];

const BAD: CompatSample[] = [
  {
    id: 'err-undefined-func',
    name: '错误：未定义函数',
    expectFail: true,
    image: `void mainImage(out vec4 o, in vec2 f) { o = vec4(helper(f)); }`,
  },
  {
    id: 'err-bad-call',
    name: '错误：调用参数不匹配',
    expectFail: true,
    image: `void mainImage(out vec4 o, in vec2 f) { o = mix(f, f, vec3(0.5)); }`,
  },
  {
    id: 'err-no-main',
    name: '错误：缺少 mainImage',
    expectFail: true,
    image: `void someFunc() { }`,
  },
];

export const COMPAT_SAMPLES: CompatSample[] = [...GOOD, ...BAD];

export const COMPAT_GOOD_COUNT = GOOD.length;
export const COMPAT_BAD_COUNT = BAD.length;