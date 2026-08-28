export interface GlslSnippet {
  prefix: string;
  description: string;
  body: string;
}

export const GLSL_SNIPPETS: GlslSnippet[] = [
  {
    prefix: 'hash11',
    description: '1D 随机（整数 → 0..1）',
    body: 'float hash11(float p) {\n    p = fract(p * 0.1031);\n    p *= p + 33.33;\n    p *= p + p;\n    return fract(p);\n}',
  },
  {
    prefix: 'hash21',
    description: '2D 随机（vec2 → 0..1）',
    body: 'float hash21(vec2 p) {\n    p = fract(p * vec2(234.34, 435.345));\n    p += dot(p, p + 34.23);\n    return fract(p.x * p.y);\n}',
  },
  {
    prefix: 'hash12',
    description: 'vec2 随机（单值 → 2D）',
    body: 'vec2 hash12(float p) {\n    vec3 p3 = fract(vec3(p) * 0.1031);\n    p3 += dot(p3, p3.yzx + 33.33);\n    return fract((p3.xx + p3.yz) * p3.zy);\n}',
  },
  {
    prefix: 'vnoise',
    description: 'Value 噪声（双线性插值）',
    body: 'float vnoise(vec2 p) {\n    vec2 i = floor(p);\n    vec2 f = fract(p);\n    vec2 u = f * f * (3.0 - 2.0 * f);\n    float a = hash21(i);\n    float b = hash21(i + vec2(1.0, 0.0));\n    float c = hash21(i + vec2(0.0, 1.0));\n    float d = hash21(i + vec2(1.0, 1.0));\n    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}',
  },
  {
    prefix: 'fbm',
    description: '分形叠加 FBM（多倍频）',
    body: 'float fbm(vec2 p) {\n    float v = 0.0;\n    float a = 0.5;\n    for (int i = 0; i < 5; i++) {\n        v += a * vnoise(p);\n        p *= 2.02;\n        a *= 0.5;\n    }\n    return v;\n}',
  },
  {
    prefix: 'perlin',
    description: 'Perlin 噪声（梯度点乘）',
    body: 'float perlin(vec2 p) {\n    vec2 i = floor(p);\n    vec2 f = fract(p);\n    vec2 u = f * f * (3.0 - 2.0 * f);\n    vec2 dir = vec2(0.0, 1.0);\n    float dot2 = dot(dir, f);\n    return mix(mix(dot2, 0.0, u.x), mix(0.0, 0.0, u.x), u.y);\n}',
  },
  {
    prefix: 'rot2',
    description: '2D 点旋转（返回旋转后的坐标）',
    body: 'vec2 rot2(vec2 p, float a) {\n    float c = cos(a);\n    float s = sin(a);\n    return mat2(c, -s, s, c) * p;\n}',
  },
  {
    prefix: 'rot2mat',
    description: '2D 旋转矩阵构造',
    body: 'mat2 rot2m(float a) {\n    float c = cos(a);\n    float s = sin(a);\n    return mat2(c, -s, s, c);\n}',
  },
  {
    prefix: 'rot3y',
    description: '3D Y 轴旋转矩阵',
    body: 'mat3 rot3y(float a) {\n    float c = cos(a);\n    float s = sin(a);\n    return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);\n}',
  },
  {
    prefix: 'sbox2d',
    description: '2D 长方体 SDF',
    body: 'float sbox2d(vec2 p, vec2 b) {\n    vec2 d = abs(p) - b;\n    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);\n}',
  },
  {
    prefix: 'scircle',
    description: '2D 圆 SDF',
    body: 'float scircle(vec2 p, float r) {\n    return length(p) - r;\n}',
  },
  {
    prefix: 'sround',
    description: '2D 圆角矩形 SDF',
    body: 'float sround(vec2 p, vec2 b, float r) {\n    vec2 q = abs(p) - b + r;\n    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;\n}',
  },
  {
    prefix: 'sline',
    description: '2D 线段 SDF',
    body: 'float sline(vec2 p, vec2 a, vec2 b) {\n    vec2 pa = p - a;\n    vec2 ba = b - a;\n    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);\n    return length(pa - ba * h);\n}',
  },
  {
    prefix: 'uvcenter',
    description: 'UV 居中（原点在画布中心）',
    body: 'vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;',
  },
  {
    prefix: 'uvrot',
    description: '旋转 UV（居中后绕中心旋转）',
    body: 'vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;\nuv = rot2(uv, $1);',
  },
  {
    prefix: 'palette',
    description: 'IQ 调色板函数（在 0..1 内映射）',
    body: 'vec3 palette(float t) {\n    vec3 a = vec3(0.5, 0.5, 0.5);\n    vec3 b = vec3(0.5, 0.5, 0.5);\n    vec3 c = vec3(1.0, 1.0, 1.0);\n    vec3 d = vec3(0.263, 0.416, 0.557);\n    return a + b * cos(6.28318 * (c * t + d));\n}',
  },
  {
    prefix: 'triwave',
    description: '三角波（0..1 往复）',
    body: 'float triwave(float t) {\n    return abs(fract(t) * 2.0 - 1.0);\n}',
  },
  {
    prefix: 'aaedge',
    description: '反走样边缘（smoothstep 帮边）',
    body: 'float aaedge(float d) {\n    return smoothstep(1.0 / iResolution.y, -1.0 / iResolution.y, d);\n}',
  },
  {
    prefix: 'dither',
    description: '闪烁抗干涉（像素级抖动）',
    body: '#define dither(p) (hash21(floor(p) + iTime * 0.0))',
  },
  {
    prefix: 'mandelbrot',
    description: 'Mandelbrot 迭代迭代数',
    body: 'float mandelbrot(vec2 z0) {\n    vec2 z = z0;\n    for (int i = 0; i < 64; i++) {\n        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + z0;\n        if (dot(z, z) > 4.0) return float(i);\n    }\n    return 64.0;\n}',
  },
  {
    prefix: 'sdsphere',
    description: '3D 球 SDF',
    body: 'float sdsphere(vec3 p, float r) {\n    return length(p) - r;\n}',
  },
  {
    prefix: 'raydir',
    description: '透视射线方向（uv → 世界方向）',
    body: 'vec3 raydir(vec2 uv, float fov, mat3 rot) {\n    vec3 rd = normalize(vec3(uv, 1.0 / tan(radians(fov) * 0.5)));\n    return rot * rd;\n}',
  },
  {
    prefix: 'gauss',
    description: '高斯采样权重（模糊核）',
    body: 'float gauss(float x, float sigma) {\n    return exp(-(x * x) / (2.0 * sigma * sigma)) / (sigma * 2.50662827);\n}',
  },
];

export function snippetsMatching(word: string): GlslSnippet[] {
  const w = word.toLowerCase();
  return GLSL_SNIPPETS.filter((s) => s.prefix.toLowerCase().startsWith(w)).slice(0, 12);
}