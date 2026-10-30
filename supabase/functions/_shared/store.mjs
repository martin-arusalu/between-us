import { GameError } from '../../../game.mjs';

export class RoomStore {
  constructor({ url, key, request = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.request = request;
    this.headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }
  async rest(path, options = {}) {
    const response = await this.request(`${this.url}/rest/v1/${path}`, {
      ...options, headers: { ...this.headers, ...options.headers }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new GameError('Room storage is unavailable. Please retry.', 503);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async get(code) {
    if (!/^[A-Z2-9]{6}$/.test(code)) throw new GameError('Room not found.', 404);
    const rows = await this.rest(`game_rooms?code=eq.${code}&select=state,version,expires_at`);
    const row = rows[0];
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw new GameError('Room not found. It may have expired.', 404);
    return row;
  }
  async create(room) {
    const response = await this.request(`${this.url}/rest/v1/game_rooms`, {
      method: 'POST', headers: this.headers, body: JSON.stringify({ code: room.code, state: room }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new GameError('Room storage is unavailable. Please retry.', 503);
    return true;
  }
  async swap(room, version) {
    const rows = await this.rest(`game_rooms?code=eq.${room.code}&version=eq.${version}&select=code`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ state: room, version: version + 1, expires_at: new Date(room.touched + 43_200_000).toISOString() }),
    });
    return rows.length === 1;
  }
  async mutate(code, update) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const row = await this.get(code);
      const result = update(row.state);
      if (await this.swap(row.state, row.version)) return { room: row.state, result };
    }
    throw new GameError('The room is busy. Please retry.', 409);
  }
  async recentWords() {
    return (await this.rest('game_words?select=word&order=chosen_at.desc&limit=500')).map(row => row.word);
  }
  async allowCreate(ip) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return this.rest('rpc/game_allow_create', { method: 'POST', body: JSON.stringify({ ip_hash: hash }) });
  }
  async rememberWord(word) {
    await this.rest('game_words', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ word, chosen_at: new Date().toISOString() }) });
  }
  async storage(path, options = {}) {
    const response = await this.request(`${this.url}/storage/v1/${path}`, {
      ...options, headers: { ...this.headers, ...options.headers }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GameError('Audio storage is unavailable.', response.status === 404 ? 404 : 503);
    return response;
  }
  put(path, data) {
    return this.storage(`object/room-audio/${path}`, { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: data });
  }
  async audio(path) {
    return (await this.storage(`object/authenticated/room-audio/${path}`)).arrayBuffer();
  }
  async clearAudio(code, round) {
    // Only the immediately preceding round can have retained audio. Clear it on the next start.
    if (round < 1) return;
    const prefix = `${code}/${round}`;
    const response = await this.storage('object/list/room-audio', {
      method: 'POST', body: JSON.stringify({ prefix, limit: 1000 }),
    });
    const files = await response.json();
    if (files.length) await this.storage('object/room-audio', {
      method: 'DELETE', body: JSON.stringify({ prefixes: files.map(file => `${prefix}/${file.name}`) }),
    });
  }
}
