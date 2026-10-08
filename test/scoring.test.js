'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { kehrePoints, gameScore, sportRanking, literRanking, overallRanking, rankings } = require('../public/js/scoring.js');
const { roundRobin } = require('../public/js/schedule.js');

const team = (id) => ({ id, name: 'Team ' + id });
const player = (id, teamId) => ({ id, name: id, teamId });
const k = (team, stocks) => ({ team, stocks });

test('Kehre: 3 Punkte für den besten Stock, +2 für jeden weiteren', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(kehrePoints), [0, 3, 5, 7, 9]);
});

test('Spielstand summiert Kehren, ignoriert leere und 0-Kehren', () => {
  const g = { kehren: [k('a', 1), k('b', 2), k('x', 0), null, k(null, 0), k('a', 4)] };
  assert.deepEqual(gameScore(g), { a: 12, b: 5 });
});

test('Sportwertung: Spielpunkte, dann Stocknote', () => {
  const state = {
    teams: [team('A'), team('B'), team('C')],
    games: [
      { teamA: 'A', teamB: 'B', done: true, kehren: [k('a', 1)] },          // A 3:0
      { teamA: 'B', teamB: 'C', done: true, kehren: [k('a', 4)] },          // B 9:0
      { teamA: 'C', teamB: 'A', done: true, kehren: [k('a', 2), k('b', 1)] }, // C 5:3
      { teamA: 'A', teamB: 'C', done: false, kehren: [k('a', 4)] },         // nicht beendet -> zählt nicht
    ],
    drinks: [],
  };
  const r = sportRanking(state);
  // Alle 2 Punkte. Noten: A 6/5=1.2, B 9/3=3, C 5/12
  assert.deepEqual(r.map((x) => [x.teamId, x.points, x.place]), [['B', 2, 1], ['A', 2, 2], ['C', 2, 3]]);
  assert.equal(r[0].plus, 9);
  assert.equal(r[0].minus, 3);
});

test('Sportwertung: Unentschieden und gleiche Plätze', () => {
  const state = {
    teams: [team('A'), team('B')],
    games: [{ teamA: 'A', teamB: 'B', done: true, kehren: [k('a', 1), k('b', 1)] }],
    drinks: [],
  };
  const r = sportRanking(state);
  assert.deepEqual(r.map((x) => [x.points, x.draw, x.place]), [[1, 1, 1], [1, 1, 1]]);
});

test('Stocknote ohne Gegenpunkte ist unendlich (null) und schlägt alles', () => {
  const state = {
    teams: [team('A'), team('B'), team('C')],
    games: [
      { teamA: 'A', teamB: 'B', done: true, kehren: [k('a', 1)] },
      { teamA: 'C', teamB: 'B', done: true, kehren: [k('a', 4), k('b', 1)] },
    ],
    drinks: [],
  };
  const r = sportRanking(state);
  assert.equal(r[0].teamId, 'A');
  assert.equal(r[0].stocknote, null);
});

test('Literwertung: Team-Summe, Ø pro Kopf, Einzelwertung, Personen ohne Team', () => {
  const state = {
    teams: [team('A'), team('B')],
    players: [player('a1', 'A'), player('a2', 'A'), player('b1', 'B'), player('solo', null)],
    games: [],
    drinks: [
      { personId: 'a1', liters: 0.5 }, { personId: 'a1', liters: 0.5 },
      { personId: 'a2', liters: 0.3 }, { personId: 'b1', liters: 1 }, { personId: 'solo', liters: 0.5 },
      { personId: 'gelöscht', liters: 5 },
    ],
  };
  const r = literRanking(state);
  assert.deepEqual(r.teams.map((t) => [t.teamId, t.liters, t.perHead, t.place]), [['A', 1.3, 0.65, 1], ['B', 1, 1, 2]]);
  assert.deepEqual(r.people.map((p) => [p.personId, p.liters, p.place]),
    [['a1', 1, 1], ['b1', 1, 1], ['solo', 0.5, 3], ['a2', 0.3, 4]]);
  assert.equal(r.people.find((p) => p.personId === 'solo').teamId, null, 'ohne Mannschaft');
  assert.equal(r.total, 2.8);
});

test('Gesamtwertung: Platzsumme, Gleichstand -> besserer Sportplatz', () => {
  const sport = [{ teamId: 'A', name: 'A', place: 1 }, { teamId: 'B', name: 'B', place: 2 }, { teamId: 'C', name: 'C', place: 3 }];
  const liter = { teams: [{ teamId: 'C', place: 1 }, { teamId: 'B', place: 2 }, { teamId: 'A', place: 3 }] };
  const r = overallRanking(sport, liter);
  assert.deepEqual(r.map((x) => [x.teamId, x.sum, x.place]), [['A', 4, 1], ['B', 4, 2], ['C', 4, 3]]);
});

for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  test(`Spielplan Jeder gegen Jeden mit ${n} Mannschaften`, () => {
    const ids = Array.from({ length: n }, (_, i) => 'T' + i);
    const games = roundRobin(ids);
    assert.equal(games.length, (n * (n - 1)) / 2);
    const pairs = new Set(games.map((g) => [g.teamA, g.teamB].sort().join('-')));
    assert.equal(pairs.size, games.length, 'keine doppelte Paarung');
    const rounds = new Map();
    for (const g of games) {
      const set = rounds.get(g.round) || new Set();
      assert.ok(!set.has(g.teamA) && !set.has(g.teamB), 'niemand spielt zweimal pro Runde');
      set.add(g.teamA).add(g.teamB);
      rounds.set(g.round, set);
    }
    assert.equal(rounds.size, n % 2 ? n : n - 1);
  });
}

test('Am Start: keine Wertung aktiv, alle haben 0', () => {
  const state = { teams: [team('A'), team('B')], players: [player('a1', 'A')], games: [{ teamA: 'A', teamB: 'B', done: false, kehren: [] }], drinks: [] };
  const r = rankings(state);
  assert.deepEqual(r.active, { sport: false, liter: false });
  assert.deepEqual(r.overall.map((x) => x.sum), [0, 0]);
});

test('Gesamt zählt nur aktive Wertungen', () => {
  const state = {
    teams: [team('A'), team('B')], players: [player('a1', 'A'), player('b1', 'B')],
    games: [], drinks: [{ personId: 'b1', liters: 0.5 }],
  };
  const r = rankings(state);
  assert.deepEqual(r.active, { sport: false, liter: true });
  assert.deepEqual(r.overall.map((x) => [x.teamId, x.sum, x.place]), [['B', 1, 1], ['A', 2, 2]]);
});
