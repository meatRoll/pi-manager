/** Presentation only. Remote labels follow the configured logical source;
 * local checkouts may supply their own Git origin. Never trust a snapshot path
 * or package.json.repository (which may still point at an upstream fork).
 */
export function packageDisplayName(source: string, manifestName?: string, localOrigin?: string): string {
  const value = source.trim();
  if (value.startsWith('npm:')) {
    const spec = value.slice(4).trim();
    const name = /^(?:@[^/@\s]+\/)?[^@\s]+/.exec(spec)?.[0];
    return name || manifestName || source;
  }
  if (isGitSource(value)) return gitRepositoryLabel(value) || source;
  return (localOrigin && gitRepositoryLabel(localOrigin.trim())) || manifestName || source;
}

function isGitSource(value: string) {
  return value.startsWith('git:') || /^(?:(?:git\+)?(?:https?|ssh|git):\/\/|git@)/i.test(value);
}

function gitRepositoryLabel(value: string): string | undefined {
  if (!isGitSource(value)) return undefined;
  const gitPrefix = value.startsWith('git:') && !value.startsWith('git://');
  let repo = gitPrefix ? value.slice(4).trim() : value;
  repo = repo.replace(/^git\+/, '');
  let host: string, path: string;
  try {
    if (repo.includes('://')) {
      const url = new URL(repo);
      host = url.host; path = url.pathname.replace(/^\/+/, '');
    } else {
      const scp = /^git@([^:]+):(.+)$/.exec(repo);
      const hosted = /^(github|gitlab|bitbucket):(.+)$/.exec(repo);
      if (scp) { host = scp[1]; path = scp[2]; }
      else if (hosted) { host = `${hosted[1]}.${hosted[1] === 'bitbucket' ? 'org' : 'com'}`; path = hosted[2]; }
      else {
        const repository = repo.split(/[@#?]/, 1)[0];
        const parts = repository.split('/');
        // Historical git:owner/repo shorthand means GitHub, not a local path.
        if (parts.length === 2 && !parts[0].includes('.')) { host = 'github.com'; path = repository; }
        else { host = parts.shift() || ''; path = parts.join('/'); }
      }
    }
    path = path.split(/[@#?]/, 1)[0].replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!host || path.split('/').length < 2 || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\s]/.test(path)) return undefined;
    // Keep other hosts/subgroups visible to avoid conflating unrelated repos.
    return host.toLowerCase() === 'github.com' ? path : `${host}/${path}`;
  } catch { return undefined; }
}
