/**
 * Function sources use NodeNext `./x.js` specifiers so the compiled output resolves
 * correctly in production. When running the uncompiled `.ts` files under
 * `--experimental-strip-types`, retry those specifiers against the `.ts` source.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
