/* Ambient declarations for build-time defines.
 *
 * `__APP_VERSION__` is replaced by Vite's `define` hook (see vite.config.ts)
 * with the current version from the monorepo root package.json. Used by
 * the Settings → About panel. */

declare const __APP_VERSION__: string;
