import { parsePatch } from 'diff';

/** Only a complete, positively identified prose diff can omit script checks. */
export function patchKind(patch: string): 'documents' | 'scripts' | 'unknown' {
  try {
    // parsePatch can discard a leading mode-only/rename-only Git entry when another
    // file follows. Parse each entry separately before asserting documents only.
    const entries = patch.split(/(?=^diff --git )/m).filter(p => p.trim()).map(p => parsePatch(p));
    if (!entries.length || entries.some(changes => !changes.length || changes.some(p => !p.oldFileName || !p.newFileName || !p.hunks.length))) return 'unknown';
    const changes = entries.flat();
    const paths = changes.flatMap(p => [p.oldFileName!, p.newFileName!]).filter(p => p !== '/dev/null');
    if (paths.some(p => /\.(js|mjs|cjs|ts|py|sh|c|h|cpp|rs|go|jl|lean|sql)$/i.test(p))) return 'scripts';
    return paths.length && paths.every(p => /\.(md|markdown|tex|txt|rst|org|adoc)$/i.test(p)) ? 'documents' : 'unknown';
  } catch { return 'unknown'; }
}

export function patchGuidance(patch: string, configured = ''): string {
  const kind = patchKind(patch);
  if (kind === 'documents') return 'This return carries a patch that touches served documents only, no scripts: apply it to a copy of the served file and read the diff before judging; there is no bound output block to check.';
  if (kind === 'scripts') return `This return carries a patch against served scripts. Apply it to a copy of the served file and read the diff before judging. ${configured}`.trimEnd();
  return `This return carries a patch whose targets are not confirmed as documents only. Apply it to a copy and inspect the changed files before judging.${configured ? ` If a touched script has a bound output block, follow its check: ${configured}` : ''}`;
}
