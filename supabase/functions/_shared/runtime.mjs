import { Buffer } from 'node:buffer';
import { createProviders } from './providers.mjs';
import { RoomStore } from './store.mjs';
import { createHandler } from './handler.mjs';

// The existing TTS provider also runs in Node; make its binary type explicit in Deno.
globalThis.Buffer = Buffer;
const env = Deno.env.toObject();
const key = env.SUPABASE_SERVICE_ROLE_KEY || Object.values(JSON.parse(env.SUPABASE_SECRET_KEYS || '{}'))[0];
if (!env.SUPABASE_URL || !key) throw new Error('Supabase server credentials are missing.');
export const handler = createHandler({
  store: new RoomStore({ url: env.SUPABASE_URL, key }),
  providers: createProviders(env),
  allowedOrigins: env.ALLOWED_ORIGINS || '*',
  waitUntil: promise => EdgeRuntime.waitUntil(promise),
});
