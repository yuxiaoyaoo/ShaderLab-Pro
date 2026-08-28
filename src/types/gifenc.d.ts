/** gifenc 类型声明（该包未随附 .d.ts） */
declare module 'gifenc' {
  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444';
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
  }

  export interface ApplyPaletteOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444';
  }

  export interface WriteFrameOptions {
    palette?: number[][];
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: QuantizeOptions,
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;

  export function nearestColorIndex(palette: number[][], pixel: number[]): number;
  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    opts?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;
}
