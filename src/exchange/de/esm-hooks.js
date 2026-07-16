// Node ESM resolve hook: lets packages compiled for bundlers (like
// @decibeltrade/sdk, built with plain tsc) load under plain Node. Fixes two
// bundler-isms Node refuses natively:
//   1. extensionless / directory relative imports ('./admin')
//      -> retry './admin.js' then './admin/index.js'
//   2. JSON imports without `with { type: 'json' }`
//      -> attach the import attribute on the resolved URL
// Registered from decibel.js right before the SDK is imported.
export async function resolve(specifier, context, nextResolve) {
  try {
    return withJsonAttr(await nextResolve(specifier, context), context);
  } catch (e) {
    const retriable = e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
    if (retriable && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      for (const cand of [specifier + '.js', specifier + '/index.js']) {
        try { return withJsonAttr(await nextResolve(cand, context), context); } catch { /* next */ }
      }
    }
    throw e;
  }
}

function withJsonAttr(resolved, context) {
  if (resolved?.url?.split('?')[0].endsWith('.json')) {
    const attrs = resolved.importAttributes ?? context.importAttributes ?? {};
    if (attrs.type !== 'json') {
      return { ...resolved, importAttributes: { ...attrs, type: 'json' } };
    }
  }
  return resolved;
}
