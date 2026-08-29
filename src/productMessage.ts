export type ProductMessageParams = Readonly<Record<string, string | number>>;

/** Stable product-owned text. External/provider/parser/compiler text belongs in rawDetail. */
export interface ProductMessageDescriptor<TCode extends string = string> {
  code: TCode;
  params?: ProductMessageParams;
  rawDetail?: string;
  /** Compatibility text for older producers or clients; never preferred over a known code. */
  fallback?: string;
}

export class ProductError extends Error implements ProductMessageDescriptor {
  readonly code: string;
  readonly params?: ProductMessageParams;
  readonly rawDetail?: string;
  readonly fallback?: string;

  constructor(descriptor: ProductMessageDescriptor, options?: ErrorOptions) {
    super(descriptor.fallback ?? descriptor.rawDetail ?? descriptor.code, options);
    this.name = 'ProductError';
    this.code = descriptor.code;
    this.params = descriptor.params;
    this.rawDetail = descriptor.rawDetail;
    this.fallback = descriptor.fallback;
  }

  get descriptor(): ProductMessageDescriptor {
    return {
      code: this.code,
      ...(this.params ? { params: this.params } : {}),
      ...(this.rawDetail ? { rawDetail: this.rawDetail } : {}),
      ...(this.fallback ? { fallback: this.fallback } : {}),
    };
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function messageParams(value: unknown): ProductMessageParams | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string | number] => (
    typeof entry[1] === 'string' || typeof entry[1] === 'number'
  ));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const MAX_DESCRIPTOR_DEPTH = 8;

function normalizeProductMessageValue(
  value: unknown,
  fallbackCode: string,
  seen: WeakSet<object>,
  depth: number,
): ProductMessageDescriptor {
  if (value instanceof ProductError) return value.descriptor;
  if (value && typeof value === 'object') {
    if (seen.has(value) || depth >= MAX_DESCRIPTOR_DEPTH) return { code: fallbackCode };
    seen.add(value);
    const object = value as Record<string, unknown>;
    const nested = object.descriptor;
    if (nested && nested !== value) {
      return normalizeProductMessageValue(nested, fallbackCode, seen, depth + 1);
    }
    const code = text(object.code);
    if (code) {
      const params = messageParams(object.params);
      const rawDetail = text(object.rawDetail ?? object.raw_detail);
      const fallback = text(object.fallback ?? object.message ?? object.reason);
      return {
        code,
        ...(params ? { params } : {}),
        ...(rawDetail ? { rawDetail } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }
    if (value instanceof Error) {
      return { code: fallbackCode, rawDetail: value.message, fallback: value.message };
    }
  }
  const detail = text(value);
  return { code: fallbackCode, ...(detail ? { rawDetail: detail, fallback: detail } : {}) };
}

export function normalizeProductMessage(
  value: unknown,
  fallbackCode = 'product.unknown',
): ProductMessageDescriptor {
  return normalizeProductMessageValue(value, fallbackCode, new WeakSet<object>(), 0);
}

export function productError(value: unknown, fallbackCode?: string): ProductError {
  return value instanceof ProductError ? value : new ProductError(normalizeProductMessage(value, fallbackCode));
}
