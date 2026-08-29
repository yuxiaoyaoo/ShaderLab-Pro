import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { SrcPassId } from '../project/types';
import { GLSL_LANGUAGE_ID } from './glslLanguage';
import { BUILTIN_FUNCS, BUILTIN_VARS } from './glslData';
import { snippetsMatching } from './snippets';

export interface PassSource {
  id: SrcPassId;
  label: string;
  text: string;
}

export interface FuncSymbol {
  name: string;
  ret: string;
  params: { name: string; type: string }[];
  pass: SrcPassId;
  line: number;
}

export interface VarSymbol {
  name: string;
  type: string;
  kind: 'uniform' | 'const' | 'variable';
  pass: SrcPassId;
  line: number;
}

interface Analysis {
  funcs: FuncSymbol[];
  vars: VarSymbol[];
}

const DECL_TYPES =
  'float|int|uint|bool|double|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4|sampler2D|sampler3D|samplerCube|void';

const FUNC_RE = new RegExp(
  `(?:^|\\n)\\s*(?:\\b(?:const|highp|mediump|lowp|in|out|inout)\\s+)*\\b(${DECL_TYPES})\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:\\n|.)*?\\{`,
  'g',
);

const VAR_RE = new RegExp(
  `\\b(uniform|const)\\s+(?:highp|mediump|lowp\\s+)?(${DECL_TYPES})\\s+(\\w+)\\s*(?:=\\s*[^;]*)?\\s*;`,
  'g',
);

const PARAM_RE = /\b(float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|mat[234]|sampler2D|samplerCube)\s+(\w+)/g;

function analyzeText(text: string, id: SrcPassId): Analysis {
  const funcs: FuncSymbol[] = [];
  const vars: VarSymbol[] = [];
  FUNC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_RE.exec(text))) {
    const name = m[2];
    const ret = m[1];
    const paramsRaw = m[3] ?? '';
    const params: FuncSymbol['params'] = [];
    PARAM_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PARAM_RE.exec(paramsRaw))) {
      params.push({ name: pm[2], type: pm[1] });
    }
    const relLine = text.slice(0, m.index).split('\n').length;
    if (name !== 'mainImage') {
      funcs.push({ name, ret, params, pass: id, line: relLine });
    }
  }
  VAR_RE.lastIndex = 0;
  let vm: RegExpExecArray | null;
  while ((vm = VAR_RE.exec(text))) {
    vars.push({
      name: vm[3],
      type: `${vm[1]} ${vm[2]}`.trim(),
      kind: vm[1] === 'uniform' ? 'uniform' : 'const',
      pass: id,
      line: text.slice(0, vm.index).split('\n').length,
    });
  }
  return { funcs, vars };
}

let passGetter: (() => PassSource[]) | null = null;

export function setPassSourcesGetter(fn: (() => PassSource[]) | null): void {
  passGetter = fn;
}

export function collectAnalysis(): Analysis {
  const funcs: FuncSymbol[] = [];
  const vars: VarSymbol[] = [];
  for (const p of passGetter ? passGetter() : []) {
    const a = analyzeText(p.text, p.id);
    funcs.push(...a.funcs);
    vars.push(...a.vars);
  }
  return { funcs, vars };
}

export function uriForPass(id: string): monaco.Uri {
  return monaco.Uri.parse(`inmemory://shaderlab/${id}.glsl`);
}

export interface Suggestion {
  name: string;
  kind: 'func' | 'var' | 'type' | 'uniform';
  detail: string;
  insert: string;
  pass?: string;
}

const BUILTIN_TYPES = [
  'float', 'int', 'uint', 'bool', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'mat2', 'mat3', 'mat4',
  'sampler2D', 'sampler3D', 'samplerCube', 'void',
];

export function computeSuggestions(word: string, currentPass: SrcPassId): Suggestion[] {
  const w = word.toLowerCase();
  const out: Suggestion[] = [];
  for (const name of Object.keys(BUILTIN_FUNCS)) {
    if (!name.toLowerCase().startsWith(w)) continue;
    const f = BUILTIN_FUNCS[name];
    out.push({ name, kind: 'func', detail: f.sig, insert: name });
  }
  for (const v of BUILTIN_VARS) {
    if (!v.name.toLowerCase().startsWith(w)) continue;
    out.push({ name: v.name, kind: 'var', detail: `${v.type} — 内置变量`, insert: v.name });
  }
  for (const t of BUILTIN_TYPES) {
    if (!t.toLowerCase().startsWith(w)) continue;
    out.push({ name: t, kind: 'type', detail: '内置类型', insert: t });
  }
  const analysis = collectAnalysis();
  for (const f of analysis.funcs) {
    if (!f.name.toLowerCase().startsWith(w)) continue;
    const sig = `${f.ret} ${f.name}(${f.params.map((p) => `${p.type} ${p.name}`).join(', ')})`;
    out.push({
      name: f.name,
      kind: 'func',
      detail: sig,
      insert: f.name,
      pass: f.pass === currentPass ? undefined : passLabel(f.pass),
    });
  }
  const seenVars = new Set<string>();
  for (const v of analysis.vars) {
    if (seenVars.has(v.name) || !v.name.toLowerCase().startsWith(w)) continue;
    seenVars.add(v.name);
    const sig =
      v.kind === 'uniform'
        ? `uniform ${typePart(v.type)} ${v.name}`
        : `${v.type} ${v.name}`;
    out.push({
      name: v.name,
      kind: v.kind === 'uniform' ? 'uniform' : 'var',
      detail: sig,
      insert: v.name,
      pass: v.pass === currentPass ? undefined : passLabel(v.pass),
    });
  }
  return out;
}

export interface HoverInfo {
  name: string;
  kind: 'func' | 'var';
  content: string;
  pass?: string;
}

export function computeHover(word: string, currentPass: SrcPassId): HoverInfo | null {
  const f = BUILTIN_FUNCS[word];
  if (f) return { name: word, kind: 'func', content: `**${f.sig}**\n\n${f.doc}` };
  const v = BUILTIN_VARS.find((x) => x.name === word);
  if (v) {
    return { name: word, kind: 'var', content: `**${v.type}**\n\n${v.doc}` };
  }
  const analysis = collectAnalysis();
  for (const uf of analysis.funcs) {
    if (uf.name !== word) continue;
    const sig = `${uf.ret} ${uf.name}(${uf.params.map((p) => `${p.type} ${p.name}`).join(', ')})`;
    return {
      name: uf.name,
      kind: 'func',
      content: `**${sig}**\n\n声明于 ${passLabel(uf.pass)}:${uf.line}`,
      pass: uf.pass === currentPass ? undefined : passLabel(uf.pass),
    };
  }
  for (const uv of analysis.vars) {
    if (uv.name !== word) continue;
    return {
      name: uv.name,
      kind: 'var',
      content: `**${uv.type} ${uv.name}**\n\n声明于 ${passLabel(uv.pass)}:${uv.line}`,
      pass: uv.pass === currentPass ? undefined : passLabel(uv.pass),
    };
  }
  return null;
}

export interface DefinitionInfo {
  pass: string;
  line: number;
}

export function computeDefinition(
  word: string,
  currentPass: SrcPassId,
): DefinitionInfo | null {
  const analysis = collectAnalysis();
  for (const uf of analysis.funcs) {
    if (uf.name === word) return { pass: uf.pass, line: uf.line };
  }
  for (const uv of analysis.vars) {
    if (uv.name === word) return { pass: uv.pass, line: uv.line };
  }
  void currentPass;
  return null;
}

function typePart(type: string): string {
  const idx = type.indexOf(' ');
  return idx >= 0 ? type.slice(idx + 1) : type;
}

function passLabel(p: SrcPassId): string {
  if (p === 'image') return 'Image';
  if (p === 'common') return 'Common';
  if (p === 'sound') return 'Sound';
  return `Buffer ${p.replace('buffer', '').toUpperCase()}`;
}

export function registerGlslProviders(monacoNs: typeof monaco): void {
  monacoNs.languages.registerCompletionItemProvider(GLSL_LANGUAGE_ID, {
    triggerCharacters: [],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const currentPass = passIdFromUri(model.uri.toString());
      const suggestions = computeSuggestions(word.word, currentPass);
      return {
        suggestions: [
          ...snippetsMatching(word.word).map(
            (sn): monaco.languages.CompletionItem => ({
              label: sn.prefix,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: sn.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: sn.description,
              sortText: '0' + sn.prefix,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: word.endColumn,
              },
            }),
          ),
          ...suggestions.map((s) => {
          const kindMap: Record<string, monaco.languages.CompletionItemKind> = {
            func: monacoNs.languages.CompletionItemKind.Function,
            var: monacoNs.languages.CompletionItemKind.Variable,
            type: monacoNs.languages.CompletionItemKind.TypeParameter,
            uniform: monacoNs.languages.CompletionItemKind.Field,
          };
          return {
            label: s.pass ? `${s.name} (${s.pass})` : s.name,
            kind: kindMap[s.kind],
            insertText: s.kind === 'func' ? s.insert : s.insert,
            detail: s.detail,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: word.endColumn,
            },
          } as monaco.languages.CompletionItem;
        }),
        ],
      };
    },
  });

  monacoNs.languages.registerHoverProvider(GLSL_LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const currentPass = passIdFromUri(model.uri.toString());
      const info = computeHover(word.word, currentPass);
      if (!info) return null;
      return {
        range: new monacoNs.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents: [{ value: info.content }],
      };
    },
  });

  monacoNs.languages.registerDefinitionProvider(GLSL_LANGUAGE_ID, {
    provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const currentPass = passIdFromUri(model.uri.toString());
      const def = computeDefinition(word.word, currentPass);
      if (!def) return null;
      return {
        uri: uriForPass(def.pass),
        range: new monacoNs.Range(def.line, 1, def.line, 1),
      };
    },
  });
}

function passIdFromUri(uri: string): SrcPassId {
  const m = /inmemory:\/\/shaderlab\/([a-zA-Z0-9]+)\.glsl/.exec(uri);
  if (!m) return 'image';
  const id = m[1];
  if (id === 'common') return 'common';
  if (id === 'image') return 'image';
  return id as SrcPassId;
}