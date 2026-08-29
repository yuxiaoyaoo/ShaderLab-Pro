import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Let the default resolver produce the final, useful error.
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8');
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false }),
      };
    }
    return nextLoad(url, context);
  },
});
