-- Update: Trink-Erinnerung (Oktober 2026)
-- ------------------------------------------------------------------
-- Nur nötig, wenn die Datenbank schon mit einer älteren setup.sql eingerichtet wurde.
-- Einfach komplett in den Supabase "SQL Editor" kopieren und ausführen.
-- Die Codes bleiben unverändert, alle Daten bleiben erhalten. Mehrfach ausführen ist ok.
-- (Alternativ geht auch die komplette setup.sql – dann aber vorher wieder eure Codes eintragen.)

alter table settings add column if not exists reminder_minutes int not null default 0;
alter table settings add column if not exists started_at timestamptz;

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
    user_max_entry = coalesce((p_settings->>'user_max_entry')::numeric, user_max_entry),
    reminder_minutes = greatest(0, least(240, coalesce((p_settings->>'reminder_minutes')::int, reminder_minutes))),
    -- "start": true = Spielbeginn jetzt, false = Spielbeginn zurücksetzen
    started_at = case (p_settings->>'start')::boolean when true then now() when false then null else started_at end
  where id = 1;
end $$;

create or replace function save_game(p_secret text, p_id uuid, p_kehren jsonb, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  update games set kehren = p_kehren, done = p_done, updated_at = now() where id = p_id;
  -- Die erste gewertete Kehre ist der Spielbeginn (falls der Admin ihn nicht schon gesetzt hat)
  if exists (select 1 from jsonb_array_elements(p_kehren) k where k->>'team' is not null) then
    update settings set started_at = now() where id = 1 and started_at is null;
  end if;
end $$;

create or replace function reset_all(p_secret text, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(p_secret, array['admin']);
  delete from drinks where true;
  delete from games where true;
  update settings set started_at = null where id = 1;
  if p_mode = 'all' then
    delete from players where true;
    delete from teams where true;
  end if;
end $$;

notify pgrst, 'reload schema';
