import { For, Show, type Component } from 'solid-js';
import { BUFFER_LETTER, type SrcPassId } from '../project/types';
import type { UniformDecl, UniformValue } from '../shadertoy/uniforms';

interface Props {
  groups: { pass: SrcPassId; items: UniformDecl[] }[];
  values: Record<string, UniformValue>;
  onSet: (name: string, v: UniformValue) => void;
}

const passLabel = (p: SrcPassId) =>
  p === 'image' ? 'Image' : p === 'common' ? 'Common' : p === 'sound' ? 'Sound' : `Buffer ${BUFFER_LETTER[p]}`;

const toNum = (v: UniformValue, i = 0): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Array.isArray(v) ? Number(v[i]) || 0 : 0;
};

const COMPONENT_COUNT: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

const hexToRgba = (hex: string): number[] => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(n, 16);
  if (Number.isNaN(num)) return [1, 1, 1, 1];
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return [r / 255, g / 255, b / 255, 1];
};

const rgbaToHex = (v: UniformValue): string => {
  const r = Math.round(Math.min(1, Math.max(0, toNum(v, 0))) * 255);
  const g = Math.round(Math.min(1, Math.max(0, toNum(v, 1))) * 255);
  const b = Math.round(Math.min(1, Math.max(0, toNum(v, 2))) * 255);
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
};

const UniformPanel: Component<Props> = (props) => {
  const setScalar = (d: UniformDecl, v: UniformValue) => {
    if (Array.isArray(v)) {
      const count = COMPONENT_COUNT[d.type] ?? v.length;
      props.onSet(d.name, v.slice(0, count));
      return;
    }
    if (d.type === 'bool') {
      props.onSet(d.name, !!v);
      return;
    }
    if (d.type === 'int') {
      props.onSet(d.name, Math.trunc(Number(v)));
      return;
    }
    props.onSet(d.name, Number(v));
  };

  const setComponent = (d: UniformDecl, i: number, raw: number) => {
    const n = COMPONENT_COUNT[d.type] ?? 1;
    const base = Array.isArray(props.values[d.name])
      ? [...(props.values[d.name] as number[])]
      : [];
    while (base.length < n) base.push(0);
    base[i] = raw;
    props.onSet(d.name, base.slice(0, n));
  };

  return (
    <div class="uniform-pop">
      <For each={props.groups}>
        {(g) => (
          <div class="pass-block">
            <div class="pass-sec">{passLabel(g.pass)}</div>
            <For each={g.items}>
              {(d) => {
                const cur = () => props.values[d.name] ?? d.def;
                const labelId = `uniform-${g.pass}-${d.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                return (
                  <div class="u-row">
                    <div id={labelId} class="u-name" title={`${d.type} · ${d.widget}`}>
                      {d.name}
                    </div>
                    <Show
                      when={d.widget === 'toggle'}
                      fallback={
                        <Show
                          when={d.widget === 'select'}
                          fallback={<VecOrScalar d={d} cur={cur()} labelId={labelId} onScalar={setScalar} onComponent={setComponent} />}
                        >
                          <select
                            aria-labelledby={labelId}
                            value={Math.trunc(toNum(cur()))}
                            onChange={(e) => setScalar(d, Number(e.currentTarget.value))}
                          >
                            <For each={d.options ?? []}>
                              {(opt, i) => <option value={i()}>{opt}</option>}
                            </For>
                          </select>
                        </Show>
                      }
                    >
                      <input
                        type="checkbox"
                        aria-labelledby={labelId}
                        checked={!!cur()}
                        onChange={(e) => setScalar(d, e.currentTarget.checked)}
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
      <Show when={props.groups.length === 0}>
        <div class="menu-info">
          未发现可调参数。在代码中声明即可：
          <code>// @uniform float u_x 0.0 0.0 1.0 0.01</code>
        </div>
      </Show>
    </div>
  );
};

interface ValueRowProps {
  d: UniformDecl;
  cur: UniformValue;
  labelId: string;
  onScalar: (d: UniformDecl, v: UniformValue) => void;
  onComponent: (d: UniformDecl, i: number, v: number) => void;
}

const VecOrScalar: Component<ValueRowProps> = (props) => {
  const d = props.d;
  if (d.widget === 'color') {
    return (
      <div class="u-row-main">
        <input
          type="color"
          aria-labelledby={props.labelId}
          value={rgbaToHex(props.cur)}
          onChange={(e) => {
            const next = hexToRgba(e.currentTarget.value);
            if (d.type === 'vec4') next[3] = toNum(props.cur, 3);
            props.onScalar(d, next);
          }}
        />
      </div>
    );
  }
  const n = COMPONENT_COUNT[d.type];
  if (n) {
    return (
      <div class="u-vec">
        <For each={Array.from({ length: n }, (_, i) => i)}>
          {(i) => (
            <label class="u-comp">
              <input
                type="range"
                aria-label={`${d.name} ${['X', 'Y', 'Z', 'W'][i]} 滑杆`}
                min={d.min}
                max={d.max}
                step={d.step}
                value={toNum(props.cur, i)}
                onInput={(e) => props.onComponent(d, i, e.currentTarget.valueAsNumber)}
              />
              <input
                type="number"
                class="u-num"
                aria-label={`${d.name} ${['X', 'Y', 'Z', 'W'][i]} 数值`}
                min={d.min}
                max={d.max}
                step={d.step}
                value={toNum(props.cur, i)}
                onChange={(e) => props.onComponent(d, i, e.currentTarget.valueAsNumber)}
              />
            </label>
          )}
        </For>
      </div>
    );
  }
  return (
    <div class="u-row-main">
      <input
        type="range"
        class="u-range"
        aria-labelledby={props.labelId}
        min={d.min}
        max={d.max}
        step={d.step}
        value={toNum(props.cur)}
        onInput={(e) => props.onScalar(d, e.currentTarget.valueAsNumber)}
      />
      <input
        type="number"
        class="u-num"
        aria-label={`${d.name} 数值`}
        min={d.min}
        max={d.max}
        step={d.step}
        value={Number(toNum(props.cur))}
        onChange={(e) => props.onScalar(d, e.currentTarget.valueAsNumber)}
      />
    </div>
  );
};

export default UniformPanel;