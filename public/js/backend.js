// Datenzugriff: Supabase (gemeinsame Daten für alle Handys) oder lokal (nur dieses Gerät).
// Beide Varianten haben dieselben Methoden; app.js weiß nicht, welche aktiv ist.
// "secret" ist der Admin-/Bar-Code oder der Login-Schlüssel einer registrierten Person.
(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    title: 'Eurofun Touristik Betriebsausflug 2026', kehren: 6, stocks: 4,
    registrationOpen: true, selfEntry: true, userMinGap: 10, userMaxPerHour: 1.5, userMaxEntry: 0.5,
  };

  function uuid() {
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ------------------------------------------------------------ Supabase

  function supabaseBackend(url, key) {
    const base = url.replace(/\/+$/, '') + '/rest/v1';
    const headers = { apikey: key, 'Content-Type': 'application/json' };

    async function request(path, opts) {
      const res = await fetch(base + path, { ...opts, headers });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((body && (body.message || body.hint)) || 'Fehler ' + res.status);
      return body;
    }
    const get = (path) => request(path, { method: 'GET' });
    const rpc = (fn, args) => request('/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });

    return {
      kind: 'supabase',
      async load() {
        const [settings, teams, players, games, drinks] = await Promise.all([
          get('/settings?select=*'),
          get('/teams?select=id,name&order=created_at'),
          get('/players?select=id,name,team_id,registered&order=created_at'),
          get('/games?select=*&order=round,bahn'),
          get('/drinks?select=*&order=created_at'),
        ]);
        const s = settings[0] || {};
        return {
          settings: {
            title: s.title ?? DEFAULT_SETTINGS.title,
            kehren: s.kehren ?? DEFAULT_SETTINGS.kehren,
            stocks: s.stocks ?? DEFAULT_SETTINGS.stocks,
            registrationOpen: s.registration_open ?? true,
            selfEntry: s.self_entry ?? true,
            userMinGap: Number(s.user_min_gap ?? DEFAULT_SETTINGS.userMinGap),
            userMaxPerHour: Number(s.user_max_per_hour ?? DEFAULT_SETTINGS.userMaxPerHour),
            userMaxEntry: Number(s.user_max_entry ?? DEFAULT_SETTINGS.userMaxEntry),
          },
          teams,
          players: players.map((p) => ({ id: p.id, name: p.name, teamId: p.team_id, registered: p.registered })),
          games: games.map((g) => ({
            id: g.id, round: g.round, bahn: g.bahn, teamA: g.team_a, teamB: g.team_b,
            kehren: g.kehren || [], done: g.done,
          })),
          drinks: drinks.map((d) => ({
            id: d.id, personId: d.person_id, liters: Number(d.liters), createdAt: d.created_at, enteredBy: d.entered_by,
          })),
        };
      },
      login: (secret) => rpc('login', { p_secret: secret })
        .then((r) => ({ role: r.role, playerId: r.player_id })),
      register: (userCode, name, teamId, playerId) =>
        rpc('register', { p_user_code: userCode, p_name: name, p_team_id: teamId || null, p_player_id: playerId || null })
          .then((r) => ({ secret: r.secret, role: r.role, playerId: r.player_id })),
      saveSettings: (secret, s) => rpc('save_settings', {
        p_secret: secret,
        p_settings: {
          title: s.title, kehren: s.kehren, stocks: s.stocks,
          registration_open: s.registrationOpen, self_entry: s.selfEntry,
          user_min_gap: s.userMinGap, user_max_per_hour: s.userMaxPerHour, user_max_entry: s.userMaxEntry,
        },
      }),
      saveTeam: (secret, t) => rpc('save_team', { p_secret: secret, p_id: t.id || null, p_name: t.name }),
      deleteTeam: (secret, id) => rpc('delete_team', { p_secret: secret, p_id: id }),
      savePlayer: (secret, p) =>
        rpc('save_player', { p_secret: secret, p_id: p.id || null, p_name: p.name, p_team_id: p.teamId || null }),
      deletePlayer: (secret, id) => rpc('delete_player', { p_secret: secret, p_id: id }),
      resetPlayerLogin: (secret, id) => rpc('reset_player_login', { p_secret: secret, p_id: id }),
      setSchedule: (secret, games) => rpc('set_schedule', {
        p_secret: secret,
        p_games: games.map((g) => ({ round: g.round, bahn: g.bahn, team_a: g.teamA, team_b: g.teamB })),
      }),
      addGame: (secret, g) => rpc('add_game', {
        p_secret: secret, p_round: g.round, p_bahn: g.bahn, p_team_a: g.teamA, p_team_b: g.teamB,
      }),
      saveGame: (secret, g) =>
        rpc('save_game', { p_secret: secret, p_id: g.id, p_kehren: g.kehren, p_done: g.done }),
      deleteGame: (secret, id) => rpc('delete_game', { p_secret: secret, p_id: id }),
      addDrink: (secret, personId, liters) =>
        rpc('add_drink', { p_secret: secret, p_player_id: personId, p_liters: liters }),
      deleteDrink: (secret, id) => rpc('delete_drink', { p_secret: secret, p_id: id }),
      reset: (secret, mode) => rpc('reset_all', { p_secret: secret, p_mode: mode }),
    };
  }

  // ------------------------------------------------------------ Lokal (ein Gerät, immer Admin)

  function localBackend(storageKey) {
    const empty = () => ({ settings: { ...DEFAULT_SETTINGS }, teams: [], players: [], games: [], drinks: [] });
    function read() {
      try {
        const s = JSON.parse(localStorage.getItem(storageKey));
        return s ? { ...empty(), ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } } : empty();
      } catch (e) {
        return empty();
      }
    }
    function write(fn) {
      const s = read();
      const result = fn(s);
      localStorage.setItem(storageKey, JSON.stringify(s));
      return Promise.resolve(result);
    }

    return {
      kind: 'local',
      load: () => Promise.resolve(read()),
      login: () => Promise.resolve({ role: 'admin', playerId: null }),
      register: () => Promise.reject(new Error('Im lokalen Modus gibt es keine Registrierung.')),
      saveSettings: (secret, settings) => write((s) => { s.settings = { ...s.settings, ...settings }; }),
      saveTeam: (secret, t) => write((s) => {
        const existing = s.teams.find((x) => x.id === t.id);
        if (existing) existing.name = t.name;
        else s.teams.push({ id: uuid(), name: t.name });
      }),
      deleteTeam: (secret, id) => write((s) => {
        s.games = s.games.filter((g) => g.teamA !== id && g.teamB !== id);
        s.teams = s.teams.filter((t) => t.id !== id);
        s.players.forEach((p) => { if (p.teamId === id) p.teamId = null; });
      }),
      savePlayer: (secret, p) => write((s) => {
        const existing = s.players.find((x) => x.id === p.id);
        if (existing) Object.assign(existing, { name: p.name, teamId: p.teamId || null });
        else s.players.push({ id: uuid(), name: p.name, teamId: p.teamId || null, registered: false });
      }),
      deletePlayer: (secret, id) => write((s) => {
        s.drinks = s.drinks.filter((d) => d.personId !== id);
        s.players = s.players.filter((p) => p.id !== id);
      }),
      resetPlayerLogin: () => Promise.resolve(),
      setSchedule: (secret, games) => write((s) => {
        s.games = games.map((g) => ({ ...g, id: uuid(), kehren: [], done: false }));
      }),
      addGame: (secret, g) => write((s) => {
        s.games.push({ ...g, id: uuid(), kehren: [], done: false });
        s.games.sort((x, y) => (x.round - y.round) || (x.bahn - y.bahn));
      }),
      saveGame: (secret, g) => write((s) => {
        const game = s.games.find((x) => x.id === g.id);
        if (game) Object.assign(game, { kehren: g.kehren, done: g.done });
      }),
      deleteGame: (secret, id) => write((s) => { s.games = s.games.filter((g) => g.id !== id); }),
      addDrink: (secret, personId, liters) => write((s) => {
        const id = uuid();
        s.drinks.push({ id, personId, liters, createdAt: new Date().toISOString(), enteredBy: 'admin' });
        return id;
      }),
      deleteDrink: (secret, id) => write((s) => { s.drinks = s.drinks.filter((d) => d.id !== id); }),
      reset: (secret, mode) => write((s) => {
        s.drinks = [];
        s.games = [];
        if (mode === 'all') { s.teams = []; s.players = []; }
      }),
    };
  }

  self.Eisstock = self.Eisstock || {};
  self.Eisstock.backend = { supabaseBackend, localBackend, uuid, DEFAULT_SETTINGS };
})();
