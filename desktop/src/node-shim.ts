/**
 * Re-export of the shared node-shim helper (scripts/node-shim.mjs) so the
 * shell bundle and the build scripts create the exact same shim.
 */
export { ENTRY_ENV, SHIM_ENV, writeNodeShim } from "../scripts/node-shim.mjs";
