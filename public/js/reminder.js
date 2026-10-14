// Trink-Erinnerung: alle X Minuten ab Spielbeginn.
// Reine Rechenlogik ohne DOM, damit sie sich testen lässt (test/reminder.test.js).
(function () {
  'use strict';

  // Verpasste Erinnerungen (z. B. App erst später geöffnet) werden nur innerhalb dieses
  // Zeitfensters nachgeholt, sonst stillschweigend übersprungen.
  const GRACE_MS = 5 * 60000;

  // Welche Erinnerung ist gerade fällig?
  // startedAt: ISO-Zeit des Spielbeginns, minutes: Intervall (0 = aus),
  // lastIndex: Nummer der zuletzt auf diesem Gerät behandelten Erinnerung.
  // Ergebnis: { index, show, minutesSinceStart, nextAt } oder null, wenn nichts zu tun ist.
  function due(startedAt, minutes, now, lastIndex) {
    const start = Date.parse(startedAt || '');
    if (!minutes || minutes <= 0 || !Number.isFinite(start) || now < start) return null;
    const interval = minutes * 60000;
    const index = Math.floor((now - start) / interval);
    const nextAt = start + (index + 1) * interval;
    if (index < 1 || index <= (lastIndex || 0)) return { index, show: false, nextAt };
    const lateBy = now - (start + index * interval);
    return { index, show: lateBy <= Math.min(GRACE_MS, interval / 2), minutesSinceStart: index * minutes, nextAt };
  }

  // Erinnerungen laufen nur, solange das Turnier läuft: nach dem letzten Spiel ist Schluss.
  function active(data) {
    const st = data.settings || {};
    if (!st.reminderMinutes || !st.startedAt) return false;
    const games = data.games || [];
    return !(games.length && games.every((g) => g.done));
  }

  const fmtDuration = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m} Min.`;
    return m ? `${h} Std. ${m} Min.` : h === 1 ? '1 Stunde' : `${h} Stunden`;
  };

  const api = { due, active, fmtDuration, GRACE_MS };
  if (typeof module !== 'undefined') module.exports = api;
  else (window.Eisstock = window.Eisstock || {}).reminder = api;
})();
