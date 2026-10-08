'use strict';

// Jeder gegen Jeden (Rundensystem / Kreismethode). Bei ungerader Anzahl
// setzt pro Runde eine Mannschaft aus. Bahnen werden pro Runde durchnummeriert.
function roundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length < 2) return [];
  if (ids.length % 2) ids.push(null);
  const n = ids.length;
  const games = [];
  for (let r = 0; r < n - 1; r++) {
    let bahn = 1;
    for (let i = 0; i < n / 2; i++) {
      let a = ids[i];
      let b = ids[n - 1 - i];
      if (a === null || b === null) continue;
      // Anspiel abwechseln, damit nicht immer dieselbe Mannschaft "A" ist
      if ((r + i) % 2) [a, b] = [b, a];
      games.push({ round: r + 1, bahn: bahn++, teamA: a, teamB: b });
    }
    ids.splice(1, 0, ids.pop());
  }
  return games;
}

module.exports = { roundRobin };
