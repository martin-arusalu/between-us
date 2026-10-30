import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

test('Pages publishes only static files and a public key; links work below a repository path', async () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OPENAI_API_KEY: 'secret_must_not_be_published' },
  });
  assert.deepEqual((await readdir(new URL('../dist', import.meta.url))).sort(), ['.nojekyll', 'app.js', 'config.js', 'favicon.svg', 'index.html', 'style.css']);
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  for (const [, relative] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.equal(new URL(relative, 'https://example.github.io/between-us/').pathname.startsWith('/between-us/'), true);
  }
  const config = await readFile(new URL('../dist/config.js', import.meta.url), 'utf8');
  assert.match(config, /sb_publishable_test/);
  assert.equal(config.includes('secret_must_not_be_published'), false);
  const js = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.equal(js.includes("fetch('/api"), false);
  assert.equal(js.includes('fetch(`/api'), false);
  assert.match(js, /homeURL\.pathname/);
  assert.match(js, /homeURL\.href/);
});

test('Pages refuses a service-role or secret key', () => {
  const key = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  for (const bad of [key, 'sb_secret_never_publish']) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/build-pages.mjs'], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, PUBLIC_SUPABASE_PUBLISHABLE_KEY: bad }, stdio: 'pipe',
    }));
  }
});
