-- Eisstock-Rangliste: Datenbank-Setup für Supabase
-- ------------------------------------------------------------------
-- Komplett in den Supabase "SQL Editor" kopieren und ausführen.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden (z. B. um die PIN zu ändern).
--
-- >>> HIER DIE SCHREIB-PIN FESTLEGEN (mind. 6 Zeichen empfohlen) <<<
do $$ begin perform set_config('eisstock.pin', 'bitte-aendern', false); end $$;
-- ------------------------------------------------------------------

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  title text not null default 'Eurofun Touristik Betriebsausflug 2026',
  kehren int not null default 6 check (kehren between 1 and 12),
  stocks int not null default 4 check (stocks between 1 and 8)
);
insert into settings (id) values (1) on conflict do nothing;

create table if not exists secrets (
  id int primary key default 1 check (id = 1),
  pin text not null
);
insert into secrets (id, pin) values (1, current_setting('eisstock.pin'))
  on conflict (id) do update set pin = excluded.pin;

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  members jsonb not null default '[]'::jsonb, -- [{ "id": "...", "name": "..." }]
  created_at timestamptz not null default now()
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  round int not null default 1,
  bahn int not null default 1,
  team_a uuid not null references teams (id) on delete cascade,
  team_b uuid not null references teams (id) on delete cascade,
  kehren jsonb not null default '[]'::jsonb,   -- [{ "team": "a"|"b"|null, "stocks": n }]
  done boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists drinks (
  id uuid primary key default gen_random_uuid(),
  person_id text not null,
  liters numeric(5, 2) not null check (liters > 0 and liters <= 5),
  created_at timestamptz not null default now()
);

-- Lesen darf jeder (Rangliste am Handy), schreiben nur über die Funktionen unten.
alter table settings enable row level security;
alter table secrets enable row level security;
alter table teams enable row level security;
alter table games enable row level security;
alter table drinks enable row level security;

drop policy if exists "public read" on settings;
drop policy if exists "public read" on teams;
drop policy if exists "public read" on games;
drop policy if exists "public read" on drinks;
create policy "public read" on settings for select to anon, authenticated using (true);
create policy "public read" on teams for select to anon, authenticated using (true);
create policy "public read" on games for select to anon, authenticated using (true);
create policy "public read" on drinks for select to anon, authenticated using (true);

revoke all on secrets from anon, authenticated;

-- ---------------------------------------------------------------- Funktionen

create or replace function _check_pin(p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from secrets where id = 1 and pin = p_pin) then
    perform pg_sleep(1); -- bremst Durchprobieren
    raise exception 'Falsche PIN';
  end if;
end $$;

create or replace function check_pin(p_pin text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  return true;
exception when others then
  return false;
end $$;

create or replace function save_settings(p_pin text, p_title text, p_kehren int, p_stocks int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  update settings set title = p_title, kehren = p_kehren, stocks = p_stocks where id = 1;
end $$;

create or replace function save_team(p_pin text, p_id uuid, p_name text, p_members jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _check_pin(p_pin);
  if p_id is null then
    insert into teams (name, members) values (p_name, p_members) returning id into v_id;
  else
    update teams set name = p_name, members = p_members where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function delete_team(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  delete from drinks where person_id in (
    select m->>'id' from teams, jsonb_array_elements(members) m where teams.id = p_id);
  delete from teams where id = p_id;
end $$;

create or replace function set_schedule(p_pin text, p_games jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  delete from games where true;
  insert into games (round, bahn, team_a, team_b)
    select x.round, x.bahn, x.team_a, x.team_b
    from jsonb_to_recordset(p_games) as x(round int, bahn int, team_a uuid, team_b uuid);
end $$;

create or replace function add_game(p_pin text, p_round int, p_bahn int, p_team_a uuid, p_team_b uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _check_pin(p_pin);
  insert into games (round, bahn, team_a, team_b) values (p_round, p_bahn, p_team_a, p_team_b)
    returning id into v_id;
  return v_id;
end $$;

create or replace function save_game(p_pin text, p_id uuid, p_kehren jsonb, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  update games set kehren = p_kehren, done = p_done, updated_at = now() where id = p_id;
end $$;

create or replace function delete_game(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  delete from games where id = p_id;
end $$;

create or replace function add_drink(p_pin text, p_person_id text, p_liters numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _check_pin(p_pin);
  insert into drinks (person_id, liters) values (p_person_id, p_liters) returning id into v_id;
  return v_id;
end $$;

create or replace function delete_drink(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  delete from drinks where id = p_id;
end $$;

create or replace function reset_all(p_pin text, p_keep_teams boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _check_pin(p_pin);
  delete from drinks where true;
  delete from games where true;
  if not p_keep_teams then
    delete from teams where true;
  end if;
end $$;

revoke execute on function _check_pin(text) from public, anon, authenticated;
