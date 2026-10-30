create table public.game_rooms (
  code text primary key check (code ~ '^[A-Z2-9]{6}$'),
  state jsonb not null,
  version bigint not null default 0,
  expires_at timestamptz not null default (now() + interval '12 hours')
);
alter table public.game_rooms enable row level security;
revoke all on public.game_rooms from anon, authenticated;
grant all on public.game_rooms to service_role;
create index game_rooms_expiry on public.game_rooms(expires_at);

create table public.game_words (word text primary key, chosen_at timestamptz not null default now());
alter table public.game_words enable row level security;
revoke all on public.game_words from anon, authenticated;
grant all on public.game_words to service_role;
create index game_words_chosen on public.game_words(chosen_at desc);

create table public.game_creation_limits (key text primary key, started_at timestamptz not null, count integer not null);
alter table public.game_creation_limits enable row level security;
revoke all on public.game_creation_limits from anon, authenticated;
create function public.game_allow_create(ip_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare hits integer;
begin
  insert into public.game_creation_limits as limits (key, started_at, count) values (ip_hash, now(), 1)
  on conflict (key) do update set
    count = case when limits.started_at < now() - interval '1 hour' then 1 else limits.count + 1 end,
    started_at = case when limits.started_at < now() - interval '1 hour' then now() else limits.started_at end
  returning count into hits;
  delete from public.game_creation_limits where started_at < now() - interval '1 day';
  delete from public.game_rooms where expires_at < now();
  delete from public.game_words where word in
    (select word from public.game_words order by chosen_at desc offset 500);
  return hits <= 40;
end;
$$;
revoke all on function public.game_allow_create(text) from public, anon, authenticated;
grant execute on function public.game_allow_create(text) to service_role;

-- No browser can read this table directly: it contains the word and player tokens.
-- The Edge Function returns the same filtered public view as the local Node server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-audio', 'room-audio', false, 8388608, array['audio/mpeg'])
on conflict (id) do nothing;
