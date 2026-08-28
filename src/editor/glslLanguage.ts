import type { languages } from 'monaco-editor';

const KEYWORDS = [
  'const', 'uniform', 'varying', 'attribute', 'buffer', 'shared', 'coherent', 'volatile',
  'restrict', 'readonly', 'writeonly', 'layout', 'centroid', 'flat', 'smooth', 'noperspective',
  'patch', 'sample', 'invariant', 'precise', 'break', 'continue', 'do', 'for', 'while',
  'switch', 'case', 'default', 'if', 'else', 'discard', 'return', 'in', 'out', 'inout',
  'true', 'false', 'struct', 'void', 'precision', 'highp', 'mediump', 'lowp',
];

const TYPES = [
  'float', 'int', 'uint', 'bool', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4',
  'dvec2', 'dvec3', 'dvec4', 'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4', 'sampler2D', 'sampler3D', 'samplerCube',
  'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArray', 'isampler2D',
  'usampler2D', 'image2D', 'image1D', 'atomic_uint',
];

const BUILTINS = [
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh',
  'tanh', 'asinh', 'acosh', 'atanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt',
  'inversesqrt', 'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract',
  'mod', 'modf', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance',
  'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
  'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual',
  'any', 'all', 'not', 'textureSize', 'texture', 'textureProj', 'textureLod',
  'texelFetch', 'texelFetchOffset', 'textureGrad', 'dFdx', 'dFdy', 'dFdxFine', 'dFdyFine',
  'fwidth', 'fwidthFine', 'noise1', 'noise2', 'noise3', 'noise4',
  'barrier', 'memoryBarrier', 'groupMemoryBarrier', 'imageLoad', 'imageStore',
  'atomicAdd', 'atomicMin', 'atomicMax', 'atomicExchange', 'atomicCompSwap',
  'gl_FragCoord', 'gl_FrontFacing', 'gl_PointCoord', 'gl_VertexID', 'gl_InstanceID',
  'gl_Position', 'gl_PointSize', 'gl_FragDepth',
];

export const GLSL_LANGUAGE_ID = 'glsl';

export const glslMonarch: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.glsl',
  keywords: [...KEYWORDS],
  types: [...TYPES],
  builtins: [...BUILTINS],
  symbols: /[=><!~?:&|+\-*\/\^%]+/,
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/#\s*\w+/, 'annotation.preprocessor'],
      [/\b\d+\.\d+([eE][-+]?\d+)?[fu]?/, 'number.float'],
      [/\b\d+[fu]/, 'number'],
      [/\b\d+/, 'number'],
      [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { '@builtins': 'keyword', '@default': 'identifier' } }],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@types': 'type', '@default': 'variable' } }],
      [/@symbols/, 'operator'],
      [/[{}()[\]]/, '@brackets'],
      [/[;,.]/, 'delimiter'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
};
