import { createEffect, on, onCleanup, onMount, type Component } from 'solid-js';
import {
  ShadertoyRuntime,
  type CompileResult,
  type RuntimeApi,
  type RuntimeSetup,
  type RuntimeStats,
} from '../shadertoy/runtime';

interface Props {
  setup: () => RuntimeSetup;
  playing: () => boolean;
  onStats: (s: RuntimeStats) => void;
  onCompileResult: (r: CompileResult) => void;
  onReady: (api: RuntimeApi) => void;
}

const PreviewPane: Component<Props> = (props) => {
  let canvas!: HTMLCanvasElement;
  let rt: ShadertoyRuntime | undefined;

  onMount(() => {
    rt = new ShadertoyRuntime(canvas);
    rt.onStats = (s) => props.onStats(s);
    props.onCompileResult(rt.compile(props.setup()));
    rt.play();
    props.onReady(rt);
  });

  createEffect(
    on(
      () => props.playing(),
      (p, prev) => {
        if (!rt || p === prev) return;
        if (p) rt.play();
        else rt.pause();
      },
      { defer: true },
    ),
  );

  onCleanup(() => rt?.dispose());

  return (
    <div class="preview-pane">
      <canvas ref={canvas} />
    </div>
  );
};

export default PreviewPane;
