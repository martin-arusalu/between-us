import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const url = process.env.PUBLIC_SUPABASE_URL || 'https://jqxtqditbnuggbkronng.supabase.co';
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!key) throw new Error('Set PUBLIC_SUPABASE_PUBLISHABLE_KEY before building GitHub Pages.');
if (!key.startsWith('sb_publishable_')) {
  let claims;
  try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); } catch { /* Fail below. */ }
  if (claims?.role !== 'anon') throw new Error('The browser requires a publishable or legacy anon key, never a secret/service-role key.');
}
const parsed = new URL(url);
if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')) throw new Error('Use your HTTPS Supabase project URL.');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
// An explicit list makes it impossible to accidentally publish .env or backend source.
for (const file of ['index.html', 'app.js', 'style.css', 'favicon.svg']) await cp(path.join(root, 'public', file), path.join(dist, file));
await writeFile(path.join(dist, 'config.js'), `window.BETWEEN_US_CONFIG = ${JSON.stringify({ apiBase: `${parsed.origin}/functions/v1`, publishableKey: key })};\n`);
await writeFile(path.join(dist, '.nojekyll'), '');
console.log('GitHub Pages files built in dist/ (public configuration only).');
