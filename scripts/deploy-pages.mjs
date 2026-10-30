import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, cwd = root) => execFileSync('git', ['-c', 'credential.helper=!gh auth git-credential', ...args], { cwd, encoding: 'utf8' });
execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: root, stdio: 'inherit' });
const remote = git(['remote', 'get-url', 'origin']).trim();
const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
if (!match) throw new Error('The origin remote must be your GitHub repository.');
const repository = `${match[1]}/${match[2]}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'between-us-pages-'));
try {
  const branch = git(['ls-remote', '--heads', remote, 'gh-pages']).trim();
  if (branch) git(['clone', '--quiet', '--single-branch', '--branch', 'gh-pages', remote, temporary]);
  else {
    git(['init', '-b', 'gh-pages'], temporary);
    git(['remote', 'add', 'origin', remote], temporary);
  }
  for (const file of await readdir(temporary)) if (file !== '.git') await rm(path.join(temporary, file), { recursive: true, force: true });
  for (const file of await readdir(path.join(root, 'dist'))) await cp(path.join(root, 'dist', file), path.join(temporary, file));
  git(['add', '.'], temporary);
  if (git(['status', '--porcelain'], temporary).trim()) {
    git(['commit', '-m', 'Deploy Between Us frontend'], temporary);
    git(['push', '-u', 'origin', 'gh-pages'], temporary);
  }
  execFileSync('gh', ['api', `repos/${repository}/pages`, '--method', 'PUT', '--input', '-'], {
    input: JSON.stringify({ build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } }), stdio: ['pipe', 'ignore', 'inherit'],
  });
  console.log(`Frontend published: https://${match[1]}.github.io/${match[2]}/`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
