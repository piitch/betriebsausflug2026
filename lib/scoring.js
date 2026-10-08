'use strict';

// Punkte einer Kehre: der beste Stock an der Daube zählt 3, jeder weitere
// Stock derselben Mannschaft, der näher liegt als der beste gegnerische, zählt 2.
function kehrePoints(stocks) {
  const n = Number(stocks) || 0;
  return n > 0 ? 3 + 2 * (n - 1) : 0;
}

// Summe der Stockpunkte eines Spiels für Mannschaft A und B.
function gameScore(game) {
  let a = 0;
  let b = 0;
  for (const k of game.kehren || []) {
    if (k.team === 'a') a += kehrePoints(k.stocks);
    else if (k.team === 'b') b += kehrePoints(k.stocks);
  }
  return { a, b };
}

function compareStocknote(x, y) {
  // Stocknote = Plus / Minus; ohne Minuspunkte ist sie "unendlich".
  const qx = x.minus === 0 ? (x.plus > 0 ? Infinity : 0) : x.plus / x.minus;
  const qy = y.minus === 0 ? (y.plus > 0 ? Infinity : 0) : y.plus / y.minus;
  if (qx === qy) return 0;
  return qy > qx ? 1 : -1;
}

// Vergibt Plätze; Gleichstand (cmp === 0) ergibt denselben Platz.
function assignPlaces(sorted, cmp) {
  sorted.forEach((row, i) => {
    row.place = i > 0 && cmp(sorted[i - 1], row) === 0 ? sorted[i - 1].place : i + 1;
  });
  return sorted;
}

function sportRanking(state) {
  const rows = new Map();
  for (const t of state.teams) {
    rows.set(t.id, {
      teamId: t.id, name: t.name, games: 0, won: 0, draw: 0, lost: 0,
      points: 0, plus: 0, minus: 0,
    });
  }
  for (const g of state.games) {
    if (!g.done) continue;
    const ra = rows.get(g.teamA);
    const rb = rows.get(g.teamB);
    if (!ra || !rb) continue;
    const s = gameScore(g);
    ra.games++; rb.games++;
    ra.plus += s.a; ra.minus += s.b;
    rb.plus += s.b; rb.minus += s.a;
    if (s.a > s.b) { ra.won++; rb.lost++; ra.points += 2; }
    else if (s.b > s.a) { rb.won++; ra.lost++; rb.points += 2; }
    else { ra.draw++; rb.draw++; ra.points++; rb.points++; }
  }
  const list = [...rows.values()];
  for (const r of list) {
    r.diff = r.plus - r.minus;
    r.stocknote = r.minus === 0 ? (r.plus > 0 ? null : 0) : r.plus / r.minus; // null = ∞
  }
  const cmp = (x, y) =>
    (y.points - x.points) || compareStocknote(x, y) || (y.diff - x.diff) || (y.plus - x.plus);
  list.sort((x, y) => cmp(x, y) || x.name.localeCompare(y.name));
  return assignPlaces(list, cmp);
}

function round2(x) { return Math.round(x * 100) / 100; }

function literRanking(state) {
  const perPerson = new Map();
  for (const d of state.drinks) {
    perPerson.set(d.personId, (perPerson.get(d.personId) || 0) + d.liters);
  }
  const people = [];
  const teams = state.teams.map((t) => {
    let liters = 0;
    for (const m of t.members) {
      const l = perPerson.get(m.id) || 0;
      liters += l;
      people.push({ personId: m.id, name: m.name, team: t.name, teamId: t.id, liters: round2(l) });
    }
    const size = t.members.length;
    return {
      teamId: t.id, name: t.name, members: size,
      liters: round2(liters), perHead: size ? round2(liters / size) : 0,
    };
  });
  const teamCmp = (x, y) => (y.liters - x.liters) || (y.perHead - x.perHead);
  teams.sort((x, y) => teamCmp(x, y) || x.name.localeCompare(y.name));
  const personCmp = (x, y) => y.liters - x.liters;
  people.sort((x, y) => personCmp(x, y) || x.name.localeCompare(y.name));
  return {
    teams: assignPlaces(teams, teamCmp),
    people: assignPlaces(people, personCmp),
    total: round2(teams.reduce((s, t) => s + t.liters, 0)),
  };
}

// Gesamtwertung: Platzziffer = Platz Sport + Platz Liter (kleiner ist besser).
// Bei Gleichstand entscheidet der Sportplatz.
function overallRanking(sport, liter) {
  const literPlace = new Map(liter.teams.map((t) => [t.teamId, t.place]));
  const list = sport.map((s) => ({
    teamId: s.teamId, name: s.name,
    sportPlace: s.place, literPlace: literPlace.get(s.teamId),
    sum: s.place + literPlace.get(s.teamId),
  }));
  const cmp = (x, y) => (x.sum - y.sum) || (x.sportPlace - y.sportPlace);
  list.sort((x, y) => cmp(x, y) || x.name.localeCompare(y.name));
  return assignPlaces(list, cmp);
}

function rankings(state) {
  const sport = sportRanking(state);
  const liter = literRanking(state);
  return { sport, liter, overall: overallRanking(sport, liter) };
}

module.exports = { kehrePoints, gameScore, sportRanking, literRanking, overallRanking, rankings };
