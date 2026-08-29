import { render } from 'solid-js/web';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import App from './App';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { GLSL_LANGUAGE_ID, glslMonarch } from './editor/glslLanguage';
import './styles.css';

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

monaco.languages.register({ id: GLSL_LANGUAGE_ID });
monaco.languages.setMonarchTokensProvider(GLSL_LANGUAGE_ID, glslMonarch);
monaco.languages.setLanguageConfiguration(GLSL_LANGUAGE_ID, {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
});
monaco.editor.defineTheme('shaderlab-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword.glsl', foreground: 'c586c0' },
    { token: 'type.glsl', foreground: '4ec9b0' },
    { token: 'number.float.glsl', foreground: 'b5cea8' },
    { token: 'annotation.preprocessor.glsl', foreground: '569cd6' },
  ],
  colors: {
    'editor.background': '#0b1026',
    'editorLineNumber.foreground': '#3c4570',
    'editorLineNumber.activeForeground': '#8fa0d8',
    'editorIndentGuide.background1': '#1c2450',
    'editorGutter.background': '#0b1026',
    // 当前行用柔和背景标注，去掉基础主题自带的边框盒——长行时右边框会与代码重叠成"竖线"
    'editor.lineHighlightBackground': '#151c42',
    'editor.lineHighlightBorder': '#00000000',
  },
});
monaco.editor.defineTheme('shaderlab-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword.glsl', foreground: 'af00db' },
    { token: 'type.glsl', foreground: '267f99' },
    { token: 'number.float.glsl', foreground: '098658' },
    { token: 'annotation.preprocessor.glsl', foreground: '0000ff' },
  ],
  colors: {
    'editor.background': '#f0f3fc',
    'editorLineNumber.foreground': '#a8b0cc',
    'editorLineNumber.activeForeground': '#5a6390',
    'editorIndentGuide.background1': '#dfe4f2',
    'editorGutter.background': '#f0f3fc',
    // 同深色主题：当前行改为柔和背景，去掉基础主题继承来的边框盒
    'editor.lineHighlightBackground': '#e7ecfa',
    'editor.lineHighlightBorder': '#00000000',
  },
});

render(() => <App />, document.getElementById('root')!);
