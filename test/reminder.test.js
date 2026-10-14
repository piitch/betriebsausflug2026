'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { due, active, fmtDuration } = require('../public/js/reminder.js');

const START = '2026-10-20T14:00:00.000Z';
const at = (min) => Date.parse(START) + min * 60000;

test('Erinnerung: aus, ohne Spielbeginn oder vor dem Start nichts', () => {
  assert.equal(due(START, 0, at(90), 0), null);
  assert.equal(due(null, 30, at(90), 0), null);
  assert.equal(due(START, 30, at(-5), 0), null);
});

test('Erinnerung: erst nach dem ersten Intervall, dann jedes Mal genau einmal', () => {
  assert.equal(due(START, 30, at(29), 0).show, false);
  const first = due(START, 30, at(30.5), 0);
  assert.deepEqual([first.show, first.index, first.minutesSinceStart], [true, 1, 30]);
  assert.equal(first.nextAt, at(60));
  assert.equal(due(START, 30, at(31), 1).show, false); // schon gezeigt
  assert.equal(due(START, 30, at(61), 1).show, true);
});

test('Erinnerung: verpasste werden nur kurz nachgeholt', () => {
  assert.equal(due(START, 30, at(34), 0).show, true); // 4 Min. zu spät: noch zeigen
  const late = due(START, 30, at(50), 0); // 20 Min. zu spät: überspringen, aber merken
  assert.deepEqual([late.show, late.index], [false, 1]);
  assert.equal(due(START, 4, at(7), 0).show, false); // kurzes Intervall: nur ein halbes Intervall Toleranz
});

test('Erinnerung läuft nur bis zum letzten Spiel', () => {
  const st = { reminderMinutes: 30, startedAt: START };
  assert.equal(active({ settings: st, games: [] }), true);
  assert.equal(active({ settings: st, games: [{ done: true }, { done: false }] }), true);
  assert.equal(active({ settings: st, games: [{ done: true }, { done: true }] }), false);
  assert.equal(active({ settings: { ...st, reminderMinutes: 0 }, games: [] }), false);
  assert.equal(active({ settings: { ...st, startedAt: null }, games: [] }), false);
});

test('Dauer lesbar', () => {
  assert.deepEqual([45, 60, 90, 120].map(fmtDuration), ['45 Min.', '1 Stunde', '1 Std. 30 Min.', '2 Stunden']);
});
