/**
 * Pinned Agent CLI build id used when no local install is found (typical
 * headless OmniRoute). Bump when refreshing Cursor CLI impersonation.
 *
 * Deliberately import-free: cursorAgentCliVersion.ts (the full resolver:
 * env → local install detect → disk-cached installer scrape → this pin)
 * pulls in `node:fs`/`node:os`/`node:path`. Any client-reachable file that
 * only needs the pin string -- not the full resolver -- must import it from
 * here instead, or Turbopack/webpack chokes trying to bundle those Node
 * builtins into the browser build ("the chunking context does not support
 * external modules"). See #13436/#13509/#13568 for the same cut applied to
 * other edges reaching this same resolver.
 */
export const CURSOR_AGENT_CLI_VERSION = "2026.07.08-0c04a8a";
