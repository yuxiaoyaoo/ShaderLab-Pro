import type { SrcPassId } from '../project/types';

export type AuthoringView = 'code' | 'graph' | 'generated-code';
export type EditorCompileState = 'pending' | 'compiling' | 'ready';

export interface EditorStoreState {
  activePass: SrcPassId;
  authoringView: AuthoringView;
  compileState: EditorCompileState;
}

export function createDefaultEditorState(): EditorStoreState {
  return {
    activePass: 'image',
    authoringView: 'code',
    compileState: 'pending',
  };
}
