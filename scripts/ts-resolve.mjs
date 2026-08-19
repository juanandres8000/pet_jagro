/**
 * Hook de resolución para correr los .ts del repo con `node` a pelo.
 *
 * Node 22+ hace type-stripping nativo, pero como ESM exige la extensión en los
 * specifiers relativos y el código de `lib/` los escribe sin ella (`../pg`,
 * `./tokenStore`), la resolución falla. Este hook reintenta añadiendo `.ts` /
 * `/index.ts` sólo cuando la resolución normal ya falló, así que no cambia el
 * comportamiento de ningún import que ya resolvía.
 *
 * Uso:
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/hginet-evidence.ts
 *
 * No toca el build de Next: es exclusivo de los scripts one-off de `scripts/`.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        for (const ext of ['.ts', '/index.ts']) {
          try {
            return nextResolve(specifier + ext, context);
          } catch {
            /* sigue probando */
          }
        }
      }
      throw err;
    }
  },
});
