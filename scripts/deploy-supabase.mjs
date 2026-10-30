import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const ref = process.env.SUPABASE_PROJECT_REF || 'jqxtqditbnuggbkronng';
if (!/^[a-z]{20}$/.test(ref)) throw new Error('Invalid SUPABASE_PROJECT_REF.');
if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error('Add SUPABASE_ACCESS_TOKEN to .env first.');
const headers = { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
async function management(endpoint, body) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}${endpoint ? '/' + endpoint : ''}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Supabase ${endpoint} failed (HTTP ${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function query(sql) { return management('database/query', { query: sql }); }

const project = await management('');
console.log(`Deploying backend to ${project.name} (${ref}).`);
// Record migrations atomically so re-running this command never replays a migration.
await query(`create table if not exists public.between_us_migrations (name text primary key, hash text not null);
alter table public.between_us_migrations enable row level security;
revoke all on public.between_us_migrations from anon, authenticated;`);
const applied = await query('select name, hash from public.between_us_migrations');
for (const name of (await readdir(path.join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
  const sql = await readFile(path.join(root, 'supabase/migrations', name), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  const previous = applied.find(row => row.name === name);
  if (previous) {
    if (previous.hash !== hash) throw new Error(`Already applied migration ${name} changed; add a new migration instead.`);
    continue;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid migration filename.');
  await query(`begin;\n${sql}\ninsert into public.between_us_migrations values ('${name}', '${hash}');\ncommit;`);
  console.log(`Applied ${name}.`);
}

// Upload exactly the provider settings; never forward the deployment token or arbitrary .env entries.
const names = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_GUESSER_MODEL', 'ELEVENLABS_API_KEY',
  'ELEVENLABS_MODEL', 'ELEVENLABS_VOICE_IDS', 'ALLOWED_ORIGINS'];
const secrets = names.filter(name => process.env[name] !== undefined).map(name => ({ name, value: process.env[name] }));
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for hosted play.');
await management('secrets', secrets);
console.log('Provider settings saved as Edge Function secrets.');
await new Promise((resolve, reject) => {
  const child = spawn('npx', ['--yes', 'supabase@2.122.0', 'functions', 'deploy', '--project-ref', ref, '--use-api'], {
    cwd: root, env: process.env, stdio: 'inherit',
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Function deployment exited ${code}.`)));
});
console.log(`Backend ready: https://${ref}.supabase.co/functions/v1/game`);
