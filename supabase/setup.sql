-- Eisstock-Rangliste: Datenbank-Setup für Supabase
-- ------------------------------------------------------------------
-- Komplett in den Supabase "SQL Editor" kopieren und ausführen.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden (z. B. um Codes zu ändern);
-- vorhandene Daten bleiben erhalten, eine ältere Version wird automatisch migriert.
--
-- >>> HIER DIE DREI CODES FESTLEGEN <<<
--   admin: darf alles (Mannschaften, Spielplan, Ergebnisse, Einstellungen)
--   bar:   darf Liter für alle eintragen und löschen
--   user:  zum Selbst-Registrieren; danach darf man nur eigene Liter eintragen
-- Admin- und Bar-Code geheim halten (mind. 8 Zeichen), den User-Code bekommen alle Teilnehmer.
do $$ begin
  perform set_config('eisstock.admin_code', 'admin-bitte-aendern', false);
  perform set_config('eisstock.bar_code',   'bar-bitte-aendern',   false);
  perform set_config('eisstock.user_code',  'eisstock2026',        false);
end $$;
-- ------------------------------------------------------------------

-- ---------------------------------------------------------------- Tabellen

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  title text not null default 'Eurofun Touristik Betriebsausflug 2026',
  kehren int not null default 6 check (kehren between 1 and 12),
  stocks int not null default 4 check (stocks between 1 and 8)
);
alter table settings add column if not exists registration_open boolean not null default true;
alter table settings add column if not exists self_entry boolean not null default true;
alter table settings add column if not exists user_min_gap int not null default 10;
alter table settings add column if not exists user_max_per_hour numeric(4, 2) not null default 1.5;
alter table settings add column if not exists user_max_entry numeric(4, 2) not null default 1.0;
insert into settings (id) values (1) on conflict do nothing;

create table if not exists secrets (id int primary key default 1 check (id = 1));
alter table secrets drop column if exists pin;
alter table secrets add column if not exists admin_code text;
alter table secrets add column if not exists bar_code text;
alter table secrets add column if not exists user_code text;
insert into secrets (id, admin_code, bar_code, user_code)
  values (1, current_setting('eisstock.admin_code'), current_setting('eisstock.bar_code'), current_setting('eisstock.user_code'))
  on conflict (id) do update set
    admin_code = excluded.admin_code, bar_code = excluded.bar_code, user_code = excluded.user_code;

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists players (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  team_id uuid references teams (id) on delete set null,
  token_hash text unique,
  registered boolean generated always as (token_hash is not null) stored,
  created_at timestamptz not null default now()
);

-- Migration von Version 1: Mitspieler standen als JSON in teams.members
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'teams' and column_name = 'members') then
    insert into players (id, name, team_id, created_at)
      select m.value->>'id', m.value->>'name', t.id, t.created_at + (m.ordinality || ' ms')::interval
      from teams t, jsonb_array_elements(t.members) with ordinality m
      where coalesce(m.value->>'id', '') <> ''
      on conflict (id) do nothing;
    alter table teams drop column members;
  end if;
end $$;

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  round int not null default 1,
  bahn int not null default 1,
  team_a uuid not null references teams (id) on delete cascade,
  team_b uuid not null references teams (id) on delete cascade,
  kehren jsonb not null default '[]'::jsonb,   -- [{ "team": "a"|"b"|"x"|null, "stocks": n }]
  done boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists drinks (
  id uuid primary key default gen_random_uuid(),
  person_id text not null,
  liters numeric(5, 2) not null check (liters > 0 and liters <= 5),
  created_at timestamptz not null default now()
);
alter table drinks add column if not exists entered_by text not null default 'admin'; -- user | bar | admin
create index if not exists drinks_person_time on drinks (person_id, created_at);

-- ---------------------------------------------------------------- Rechte
-- Lesen darf jeder (Rangliste am Handy), schreiben nur über die Funktionen unten.

alter table settings enable row level security;
alter table secrets enable row level security;
alter table teams enable row level security;
alter table players enable row level security;
alter table games enable row level security;
alter table drinks enable row level security;

drop policy if exists "public read" on settings;
drop policy if exists "public read" on teams;
drop policy if exists "public read" on players;
drop policy if exists "public read" on games;
drop policy if exists "public read" on drinks;
create policy "public read" on settings for select to anon, authenticated using (true);
create policy "public read" on teams for select to anon, authenticated using (true);
create policy "public read" on players for select to anon, authenticated using (true);
create policy "public read" on games for select to anon, authenticated using (true);
create policy "public read" on drinks for select to anon, authenticated using (true);

revoke all on secrets from anon, authenticated;
-- Login-Token der Spieler niemals herausgeben: nur einzelne Spalten lesbar
revoke all on players from anon, authenticated;
grant select (id, name, team_id, registered, created_at) on players to anon, authenticated;

-- ---------------------------------------------------------------- Funktionen

-- Funktionen der Version 1 entfernen
drop function if exists _check_pin(text);
drop function if exists check_pin(text);
drop function if exists save_settings(text, text, int, int);
drop function if exists save_team(text, uuid, text, jsonb);
drop function if exists delete_team(text, uuid);
drop function if exists set_schedule(text, jsonb);
drop function if exists add_game(text, int, int, uuid, uuid);
drop function if exists save_game(text, uuid, jsonb, boolean);
drop function if exists delete_game(text, uuid);
drop function if exists add_drink(text, text, numeric);
drop function if exists delete_drink(text, uuid);
drop function if exists reset_all(text, boolean);

create or replace function _hash(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create or replace function _fmt(x numeric) returns text
language sql immutable as $$ select replace(trim_scale(x)::text, '.', ',') $$;

-- Prüft Admin-/Bar-Code oder Spieler-Login und liefert die Rolle.
create or replace function _auth(p_secret text, out role text, out player_id text)
language plpgsql security definer set search_path = public as $$
begin
  select case when p_secret = s.admin_code then 'admin' when p_secret = s.bar_code then 'bar' end
    into role from secrets s where s.id = 1;
  if role is null and coalesce(p_secret, '') <> '' then
    select p.id into player_id from players p where p.token_hash = _hash(p_secret);
    if player_id is not null then role := 'user'; end if;
  end if;
  if role is null then
    perform pg_sleep(1); -- bremst Durchprobieren
    raise exception 'Ungültiger Code oder abgemeldet';
  end if;
end $$;

create or replace function _require(p_secret text, p_roles text[]) returns text
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from _auth(p_secret);
  if not (a.role = any (p_roles)) then raise exception 'Keine Berechtigung'; end if;
  return a.role;
end $$;

-- Anmeldung prüfen (Admin/Bar-Code oder gespeicherter Spieler-Login)
create or replace function login(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from _auth(p_secret);
  return jsonb_build_object('role', a.role, 'player_id', a.player_id);
end $$;

-- Selbst registrieren: neue Person anlegen oder eine vom Admin angelegte Person übernehmen.
create or replace function register(p_user_code text, p_name text, p_team_id uuid, p_player_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not exists (select 1 from secrets where id = 1 and user_code = p_user_code) then
    perform pg_sleep(1);
    raise exception 'Falscher Teilnehmer-Code';
  end if;
  if not (select registration_open from settings where id = 1) then
    raise exception 'Die Registrierung ist geschlossen – bitte an den Admin wenden.';
  end if;
  if p_player_id is not null then
    update players set token_hash = _hash(v_token)
      where id = p_player_id and token_hash is null returning id into v_id;
    if v_id is null then
      raise exception 'Diese Person ist schon registriert. Neues Handy? Der Admin kann den Login zurücksetzen.';
    end if;
  else
    if length(v_name) < 2 or length(v_name) > 40 then raise exception 'Bitte einen Namen (2–40 Zeichen) eingeben.'; end if;
    if p_team_id is not null and not exists (select 1 from teams where id = p_team_id) then
      raise exception 'Mannschaft nicht gefunden';
    end if;
    if exists (select 1 from players where lower(name) = lower(v_name)) then
      raise exception 'Den Namen „%“ gibt es schon – bitte aus der Liste auswählen oder z. B. den Nachnamen ergänzen.', v_name;
    end if;
    insert into players (name, team_id, token_hash) values (v_name, p_team_id, _hash(v_token)) returning id into v_id;
  end if;
  return jsonb_build_object('secret', v_token, 'role', 'user', 'player_id', v_id);
end $$;

create or replace function save_settings(p_secret text, p_settings jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  update settings set
    title = coalesce(p_settings->>'title', title),
    kehren = coalesce((p_settings->>'kehren')::int, kehren),
    stocks = coalesce((p_settings->>'stocks')::int, stocks),
    registration_open = coalesce((p_settings->>'registration_open')::boolean, registration_open),
    self_entry = coalesce((p_settings->>'self_entry')::boolean, self_entry),
    user_min_gap = greatest(0, coalesce((p_settings->>'user_min_gap')::int, user_min_gap)),
    user_max_per_hour = coalesce((p_settings->>'user_max_per_hour')::numeric, user_max_per_hour),
    user_max_entry = coalesce((p_settings->>'user_max_entry')::numeric, user_max_entry)
  where id = 1;
end $$;

create or replace function save_team(p_secret text, p_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _require(p_secret, array['admin']);
  if p_id is null then
    insert into teams (name) values (p_name) returning id into v_id;
  else
    update teams set name = p_name where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

-- Löscht die Mannschaft samt Spielen; die Personen (und ihre Liter) bleiben ohne Mannschaft erhalten.
create or replace function delete_team(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from teams where id = p_id;
end $$;

create or replace function save_player(p_secret text, p_id text, p_name text, p_team_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  perform _require(p_secret, array['admin']);
  if p_id is null then
    insert into players (name, team_id) values (btrim(p_name), p_team_id) returning id into v_id;
  else
    update players set name = btrim(p_name), team_id = p_team_id where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function delete_player(p_secret text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from drinks where person_id = p_id;
  delete from players where id = p_id;
end $$;

-- Login einer Person zurücksetzen (z. B. neues Handy); sie kann sich dann neu registrieren.
create or replace function reset_player_login(p_secret text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  update players set token_hash = null where id = p_id;
end $$;

create or replace function set_schedule(p_secret text, p_games jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from games where true;
  insert into games (round, bahn, team_a, team_b)
    select x.round, x.bahn, x.team_a, x.team_b
    from jsonb_to_recordset(p_games) as x(round int, bahn int, team_a uuid, team_b uuid);
end $$;

create or replace function add_game(p_secret text, p_round int, p_bahn int, p_team_a uuid, p_team_b uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _require(p_secret, array['admin']);
  insert into games (round, bahn, team_a, team_b) values (p_round, p_bahn, p_team_a, p_team_b)
    returning id into v_id;
  return v_id;
end $$;

create or replace function save_game(p_secret text, p_id uuid, p_kehren jsonb, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  update games set kehren = p_kehren, done = p_done, updated_at = now() where id = p_id;
end $$;

create or replace function delete_game(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from games where id = p_id;
end $$;

-- Getränk eintragen. Admin/Bar: für alle, ohne Limits. User: nur für sich selbst, mit Regeln.
create or replace function add_drink(p_secret text, p_player_id text, p_liters numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a record;
  st settings;
  v_last timestamptz;
  v_hour numeric;
  v_id uuid;
begin
  select * into a from _auth(p_secret);
  if p_liters is null or p_liters <= 0 or p_liters > 5 then raise exception 'Ungültige Menge'; end if;
  if not exists (select 1 from players where id = p_player_id) then raise exception 'Person nicht gefunden'; end if;

  if a.role = 'user' then
    select * into st from settings where id = 1;
    if p_player_id <> a.player_id then raise exception 'Du kannst nur für dich selbst eintragen.'; end if;
    if not st.self_entry then
      raise exception 'Selbst eintragen ist gerade gesperrt – bitte an der Bar eintragen lassen.';
    end if;
    if p_liters > st.user_max_entry then
      raise exception 'Maximal % l pro Eintrag.', _fmt(st.user_max_entry);
    end if;
    -- Gleichzeitige Anfragen derselben Person nacheinander abarbeiten
    perform pg_advisory_xact_lock(hashtext('drink:' || p_player_id));
    -- Mindestabstand: zählt auch Einträge der Bar, damit nichts doppelt eingetragen wird
    select max(created_at) into v_last from drinks where person_id = p_player_id;
    if v_last is not null and clock_timestamp() < v_last + make_interval(mins => st.user_min_gap) then
      raise exception 'Zu schnell! Nächster Eintrag in % Min. möglich.',
        ceil(extract(epoch from (v_last + make_interval(mins => st.user_min_gap) - clock_timestamp())) / 60);
    end if;
    select coalesce(sum(liters), 0) into v_hour from drinks
      where person_id = p_player_id and created_at > clock_timestamp() - interval '1 hour';
    if v_hour + p_liters > st.user_max_per_hour then
      raise exception 'Stundenlimit erreicht: max. % l in 60 Minuten.', _fmt(st.user_max_per_hour);
    end if;
  end if;

  insert into drinks (person_id, liters, entered_by, created_at)
    values (p_player_id, p_liters, a.role, clock_timestamp()) returning id into v_id;
  return v_id;
end $$;

-- Admin/Bar: jeden Eintrag löschen. User: nur eigene, selbst gemachte Einträge der letzten 5 Minuten.
create or replace function delete_drink(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a record; d drinks;
begin
  select * into a from _auth(p_secret);
  select * into d from drinks where id = p_id;
  if d.id is null then return; end if;
  if a.role = 'user' and not (d.person_id = a.player_id and d.entered_by = 'user'
                              and d.created_at > clock_timestamp() - interval '5 minutes') then
    raise exception 'Nur eigene Einträge der letzten 5 Minuten können rückgängig gemacht werden – sonst bitte an die Bar wenden.';
  end if;
  delete from drinks where id = p_id;
end $$;

-- p_mode: 'results' = Spiele + Liter löschen, 'all' = zusätzlich Personen und Mannschaften
create or replace function reset_all(p_secret text, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from drinks where true;
  delete from games where true;
  if p_mode = 'all' then
    delete from players where true;
    delete from teams where true;
  end if;
end $$;

revoke execute on function _auth(text) from public, anon, authenticated;
revoke execute on function _require(text, text[]) from public, anon, authenticated;

notify pgrst, 'reload schema';
