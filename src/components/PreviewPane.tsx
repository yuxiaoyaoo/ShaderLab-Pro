import { createEffect, on, onCleanup, onMount, type Component } from 'solid-js';
import type { PreviewResolution } from '../previewResolution';
import {
  ShadertoyRuntime,
  type RuntimeApi,
  type RuntimeStats,
} from '../shadertoy/runtime';

interface Props {
  playing: () => boolean;
  resolution: () => PreviewResolution;
  onStats: (s: RuntimeStats) => void;
  onReady: (api: RuntimeApi) => void;
}

const PreviewPane: Component<Props> = (props) => {
  let canvas!: HTMLCanvasElement;
  let rt: ShadertoyRuntime | undefined;
  let resolutionFrame: number | undefined;

  onMount(() => {
    rt = new ShadertoyRuntime(canvas);
    rt.onStats = (s) => props.onStats(s);
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

  createEffect(
    on(
      () => props.resolution(),
      (resolution) => {
        if (!rt || resolution.mode !== 'auto') return;
        if (resolutionFrame !== undefined) cancelAnimationFrame(resolutionFrame);
        resolutionFrame = requestAnimationFrame(() => {
          resolutionFrame = undefined;
          rt?.setPreviewResolution(resolution);
        });
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    if (resolutionFrame !== undefined) cancelAnimationFrame(resolutionFrame);
    rt?.dispose();
  });

  const resolutionStyle = () => {
    const resolution = props.resolution();
    return resolution.mode === 'fixed'
      ? { '--preview-aspect': String(resolution.width / resolution.height) }
      : undefined;
  };

  return (
    <div
      class="preview-pane"
      classList={{ fixed: props.resolution().mode === 'fixed' }}
      style={resolutionStyle()}
    >
      <canvas ref={canvas} />
    </div>
  );
};

export default PreviewPane;
