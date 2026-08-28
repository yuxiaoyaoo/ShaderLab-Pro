import { For, Show, createMemo, type Component } from 'solid-js';
import { BUFFER_LETTER, type SrcPassId } from '../project/types';

export interface MappedDiag {
  line: number;
  column: number;
  message: string;
  tab: SrcPassId;
}

interface Props {
  diagnostics: MappedDiag[];
  onJump: (d: MappedDiag) => void;
}

const TAB_ORDER: Record<SrcPassId, number> = {
  image: 0,
  bufferA: 1,
  bufferB: 2,
  bufferC: 3,
  bufferD: 4,
  sound: 8,
  common: 9,
};

const tabLabel = (t: SrcPassId) =>
  t === 'common' ? 'Common'
  : t === 'image' ? 'Image'
  : t === 'sound' ? 'Sound'
  : `Buffer ${BUFFER_LETTER[t]}`;

const DiagnosticsPane: Component<Props> = (props) => {
  const sorted = createMemo(() =>
    [...props.diagnostics].sort((a, b) =>
      a.tab === b.tab ? a.line - b.line : TAB_ORDER[a.tab] - TAB_ORDER[b.tab],
    ),
  );

  return (
    <div class="diag-pane" aria-label="编译诊断">
      <div class="diag-header">
        {sorted().length > 0 ? `问题（${sorted().length}）` : '诊断'}
      </div>
      <Show
        when={sorted().length > 0}
        fallback={<div class="diag-empty">✓ 未发现编译问题</div>}
      >
        <div class="diag-list">
          <For each={sorted()}>
            {(d) => (
              <button class="diag-item" onClick={() => props.onJump(d)}>
                <span class="diag-icon" aria-hidden="true">✕</span>
                <span class="diag-tab">{tabLabel(d.tab)}</span>
                <span class="diag-loc">
                  行 {d.line}:{d.column}
                </span>
                <span class="diag-msg">{d.message}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default DiagnosticsPane;
