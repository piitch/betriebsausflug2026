// Datenzugriff: Supabase (gemeinsame Daten für alle Handys) oder lokal (nur dieses Gerät).
// Beide Varianten haben dieselben Methoden; app.js weiß nicht, welche aktiv ist.
(function () {
  'use strict';

  const DEFAULT_SETTINGS = { title: 'Eurofun Touristik Betriebsausflug 2026', kehren: 6, stocks: 4 };

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
      needsPin: true,
      async load() {
        const [settings, teams, games, drinks] = await Promise.all([
          get('/settings?select=*'),
          get('/teams?select=*&order=created_at'),
          get('/games?select=*&order=round,bahn'),
          get('/drinks?select=*&order=created_at'),
        ]);
        return {
          settings: { ...DEFAULT_SETTINGS, ...(settings[0] || {}) },
          teams: teams.map((t) => ({ id: t.id, name: t.name, members: t.members || [] })),
          games: games.map((g) => ({
            id: g.id, round: g.round, bahn: g.bahn, teamA: g.team_a, teamB: g.team_b,
            kehren: g.kehren || [], done: g.done,
          })),
          drinks: drinks.map((d) => ({
            id: d.id, personId: d.person_id, liters: Number(d.liters), createdAt: d.created_at,
          })),
        };
      },
      checkPin: (pin) => rpc('check_pin', { p_pin: pin }),
      saveSettings: (pin, s) =>
        rpc('save_settings', { p_pin: pin, p_title: s.title, p_kehren: s.kehren, p_stocks: s.stocks }),
      saveTeam: (pin, t) =>
        rpc('save_team', { p_pin: pin, p_id: t.id || null, p_name: t.name, p_members: t.members }),
      deleteTeam: (pin, id) => rpc('delete_team', { p_pin: pin, p_id: id }),
      setSchedule: (pin, games) => rpc('set_schedule', {
        p_pin: pin,
        p_games: games.map((g) => ({ round: g.round, bahn: g.bahn, team_a: g.teamA, team_b: g.teamB })),
      }),
      addGame: (pin, g) => rpc('add_game', {
        p_pin: pin, p_round: g.round, p_bahn: g.bahn, p_team_a: g.teamA, p_team_b: g.teamB,
      }),
      saveGame: (pin, g) => rpc('save_game', { p_pin: pin, p_id: g.id, p_kehren: g.kehren, p_done: g.done }),
      deleteGame: (pin, id) => rpc('delete_game', { p_pin: pin, p_id: id }),
      addDrink: (pin, personId, liters) =>
        rpc('add_drink', { p_pin: pin, p_person_id: personId, p_liters: liters }),
      deleteDrink: (pin, id) => rpc('delete_drink', { p_pin: pin, p_id: id }),
      reset: (pin, keepTeams) => rpc('reset_all', { p_pin: pin, p_keep_teams: keepTeams }),
    };
  }

  // ------------------------------------------------------------ Lokal

  function localBackend(storageKey) {
    const empty = () => ({ settings: { ...DEFAULT_SETTINGS }, teams: [], games: [], drinks: [] });
    function read() {
      try {
        const s = JSON.parse(localStorage.getItem(storageKey));
        return s ? { ...empty(), ...s } : empty();
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
      needsPin: false,
      load: () => Promise.resolve(read()),
      checkPin: () => Promise.resolve(true),
      saveSettings: (pin, settings) => write((s) => { s.settings = { ...s.settings, ...settings }; }),
      saveTeam: (pin, t) => write((s) => {
        const existing = s.teams.find((x) => x.id === t.id);
        if (existing) Object.assign(existing, { name: t.name, members: t.members });
        else s.teams.push({ id: uuid(), name: t.name, members: t.members });
      }),
      deleteTeam: (pin, id) => write((s) => {
        const team = s.teams.find((t) => t.id === id);
        const ids = new Set(team ? team.members.map((m) => m.id) : []);
        s.drinks = s.drinks.filter((d) => !ids.has(d.personId));
        s.games = s.games.filter((g) => g.teamA !== id && g.teamB !== id);
        s.teams = s.teams.filter((t) => t.id !== id);
      }),
      setSchedule: (pin, games) => write((s) => {
        s.games = games.map((g) => ({ ...g, id: uuid(), kehren: [], done: false }));
      }),
      addGame: (pin, g) => write((s) => {
        s.games.push({ ...g, id: uuid(), kehren: [], done: false });
        s.games.sort((x, y) => (x.round - y.round) || (x.bahn - y.bahn));
      }),
      saveGame: (pin, g) => write((s) => {
        const game = s.games.find((x) => x.id === g.id);
        if (game) Object.assign(game, { kehren: g.kehren, done: g.done });
      }),
      deleteGame: (pin, id) => write((s) => { s.games = s.games.filter((g) => g.id !== id); }),
      addDrink: (pin, personId, liters) => write((s) => {
        s.drinks.push({ id: uuid(), personId, liters, createdAt: new Date().toISOString() });
      }),
      deleteDrink: (pin, id) => write((s) => { s.drinks = s.drinks.filter((d) => d.id !== id); }),
      reset: (pin, keepTeams) => write((s) => {
        s.drinks = [];
        s.games = [];
        if (!keepTeams) s.teams = [];
      }),
    };
  }

  self.Eisstock = self.Eisstock || {};
  self.Eisstock.backend = { supabaseBackend, localBackend, uuid, DEFAULT_SETTINGS };
})();
