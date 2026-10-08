(function () {
  'use strict';

  const { scoring, schedule, backend: B } = window.Eisstock;
  const POLL_MS = 4000;
  const LS = { pin: 'eisstock.pin', conn: 'eisstock.connection', local: 'eisstock.localdata', rank: 'eisstock.ranktab' };
  const COLORS = ['#d33a2c', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22', '#7f7f7f'];
  const DRINKS = [0.3, 0.5, 1];

  const S = {
    api: null,
    data: { settings: { ...B.DEFAULT_SETTINGS }, teams: [], games: [], drinks: [] },
    dataJson: '',
    loaded: false,
    online: true,
    lastSync: null,
    pin: lsGet(LS.pin) || '',
    rankTab: lsGet(LS.rank) || 'sport',
    literSearch: '',
    renderPending: false,
  };

  // ------------------------------------------------------------ Hilfen

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* egal */ } }
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtL = (x) => Number(x || 0).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  const fmtNote = (r) => (r.stocknote === null ? '∞' : r.stocknote.toLocaleString('de-DE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
  const medal = (p) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[p] || p + '.');
  const team = (id) => S.data.teams.find((t) => t.id === id);
  const teamName = (id) => (team(id) || { name: '?' }).name;
  const teamColor = (id) => COLORS[Math.max(0, S.data.teams.findIndex((t) => t.id === id)) % COLORS.length];
  const swatch = (id) => `<span class="swatch" style="background:${teamColor(id)}"></span>`;

  function connection() {
    const cfg = window.EISSTOCK_CONFIG || {};
    let override = null;
    try { override = JSON.parse(lsGet(LS.conn)); } catch (e) { /* ignorieren */ }
    if (override && override.url && override.key) return { url: override.url, key: override.key, source: 'gerät' };
    if (cfg.supabaseUrl && cfg.supabaseKey) return { url: cfg.supabaseUrl, key: cfg.supabaseKey, source: 'config' };
    return null;
  }

  function initApi() {
    const c = connection();
    S.api = c ? B.supabaseBackend(c.url, c.key) : B.localBackend(LS.local);
  }

  let toastTimer;
  function toast(msg, opts = {}) {
    const el = $('#toast');
    el.className = 'toast' + (opts.error ? ' err' : '');
    el.innerHTML = `<span>${esc(msg)}</span>` + (opts.undo ? '<button data-act="toast-undo">Rückgängig</button>' : '');
    el.hidden = false;
    toast.undo = opts.undo || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; toast.undo = null; }, opts.undo ? 5000 : 2800);
  }

  function modal(html) {
    const el = $('#modal');
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = `<div class="card">${html}</div>`;
    el.hidden = false;
    const input = el.querySelector('input');
    if (input) setTimeout(() => input.focus(), 50);
  }

  // ------------------------------------------------------------ Daten laden / schreiben

  async function refresh(force) {
    try {
      const data = await S.api.load();
      const json = JSON.stringify(data);
      S.online = true;
      S.lastSync = new Date();
      S.loaded = true;
      if (force || json !== S.dataJson) {
        S.data = data;
        S.dataJson = json;
        render();
      } else {
        renderStatus();
      }
    } catch (e) {
      S.online = false;
      renderStatus();
      if (!S.loaded) render();
    }
  }

  function askPin() {
    return new Promise((resolve) => {
      modal(`
        <h2>🔒 PIN eingeben</h2>
        <p class="muted small">Zum Eintragen von Ergebnissen und Litern wird die Schreib-PIN benötigt.
          Sie bleibt auf diesem Handy gespeichert.</p>
        <form id="pinform">
          <input type="password" id="pin" autocomplete="current-password" placeholder="PIN">
          <p class="small" id="pinerr" style="color:var(--accent)"></p>
          <div class="row"><button type="button" class="btn grow" data-act="modal-close">Abbrechen</button>
          <button class="btn primary grow">Entsperren</button></div>
        </form>`);
      askPin.resolve = resolve;
      $('#pinform').onsubmit = async (ev) => {
        ev.preventDefault();
        const pin = $('#pin').value.trim();
        if (!pin) return;
        try {
          if (await S.api.checkPin(pin)) {
            S.pin = pin;
            lsSet(LS.pin, pin);
            modal(null);
            renderStatus();
            resolve(true);
          } else {
            $('#pinerr').textContent = 'Falsche PIN.';
          }
        } catch (e) {
          $('#pinerr').textContent = 'Keine Verbindung: ' + e.message;
        }
      };
    });
  }

  // Führt eine Schreibaktion aus (fragt bei Bedarf nach der PIN) und lädt danach neu.
  async function write(fn) {
    if (S.api.needsPin && !S.pin) {
      if (!(await askPin())) return false;
    }
    try {
      const result = await fn(S.pin);
      await refresh(true);
      return result ?? true;
    } catch (e) {
      if (/PIN/i.test(e.message)) {
        S.pin = '';
        lsSet(LS.pin, null);
        toast('PIN ungültig – bitte neu eingeben.', { error: true });
      } else {
        toast('Fehler: ' + e.message, { error: true });
      }
      await refresh(true);
      return false;
    }
  }

  // ------------------------------------------------------------ Routing / Rendering

  function route() {
    const h = location.hash.replace(/^#/, '') || 'rangliste';
    const [view, arg] = h.split('/');
    return { view, arg };
  }

  function render() {
    // Nicht neu zeichnen, während jemand in ein Feld tippt – sonst geht die Eingabe verloren.
    const ae = document.activeElement;
    if (ae && $('#main').contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && ae.id !== 'litersearch') {
      S.renderPending = true;
      renderStatus();
      return;
    }
    S.renderPending = false;
    const { view, arg } = route();
    document.title = S.data.settings.title || 'Eisstock-Rangliste';
    $('#title').textContent = S.data.settings.title || 'Eisstock-Rangliste';
    const tab = view === 'spiel' ? 'spiele' : view;
    document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const views = { rangliste: viewRank, spiele: viewGames, spiel: viewGame, liter: viewLiter, verwaltung: viewAdmin, regeln: viewRules };
    const main = $('#main');
    const scroll = window.scrollY;
    const keepFocus = ae && ae.id === 'litersearch' ? ae.selectionStart : null;
    main.innerHTML = (S.loaded || S.api.kind === 'local' ? '' : '<div class="empty">Lade …</div>') + (views[view] || viewRank)(arg);
    if (keepFocus !== null) {
      const s = $('#litersearch');
      if (s) { s.focus(); s.setSelectionRange(keepFocus, keepFocus); }
    }
    window.scrollTo(0, scroll);
    renderStatus();
  }

  function renderStatus() {
    const el = $('#status');
    if (S.api.kind === 'local') {
      el.innerHTML = '<span class="dot off"></span>Lokal';
    } else if (!S.online) {
      el.innerHTML = '<span class="dot err"></span>Offline';
    } else {
      el.innerHTML = `<span class="dot"></span>Live${S.pin ? ' · 🔓' : ''}`;
    }
  }

  function localBanner() {
    return S.api.kind === 'local'
      ? '<div class="banner">⚠️ <b>Lokaler Modus:</b> Daten liegen nur auf diesem Gerät. Für gemeinsame Daten auf allen Handys Supabase verbinden (siehe Setup).</div>'
      : '';
  }

  // ------------------------------------------------------------ Rangliste

  function viewRank() {
    const r = scoring.rankings(S.data);
    if (!S.data.teams.length) {
      return localBanner() + '<div class="empty"><div class="big">🥌</div>Noch keine Mannschaften.<br><a href="#verwaltung">Jetzt im Setup anlegen</a></div>';
    }
    const tabs = [['sport', 'Sport'], ['liter', 'Liter'], ['gesamt', 'Gesamt']];
    let html = localBanner() + '<div class="seg">' +
      tabs.map(([k, l]) => `<button data-act="ranktab" data-k="${k}" class="${S.rankTab === k ? 'on' : ''}">${l}</button>`).join('') +
      '</div>';

    if (S.rankTab === 'sport') {
      const played = S.data.games.filter((g) => g.done).length;
      html += `<div class="card"><table class="rank">
        <tr><th class="pl">Pl.</th><th class="l">Mannschaft</th><th>Sp</th><th>Pkt</th><th>Note</th><th>Stock</th></tr>
        ${r.sport.map((x) => `<tr>
          <td class="pl"><span class="medal">${medal(x.place)}</span></td>
          <td class="l name">${swatch(x.teamId)}${esc(x.name)}<div class="small muted">${x.won}S ${x.draw}U ${x.lost}N</div></td>
          <td>${x.games}</td><td class="big">${x.points}</td><td>${fmtNote(x)}</td>
          <td class="small">${x.plus}:${x.minus}</td></tr>`).join('')}
      </table></div>
      <p class="small muted">${played} von ${S.data.games.length} Spielen beendet. Pkt = Spielpunkte (Sieg 2, Unentschieden 1).
        Bei Gleichstand entscheidet die Stocknote (Stockpunkte erzielt ÷ erhalten). <a href="#regeln">Regeln</a></p>`;
    } else if (S.rankTab === 'liter') {
      html += `<div class="card"><table class="rank">
        <tr><th class="pl">Pl.</th><th class="l">Mannschaft</th><th>Liter</th><th>Ø/Kopf</th></tr>
        ${r.liter.teams.map((x) => `<tr>
          <td class="pl"><span class="medal">${medal(x.place)}</span></td>
          <td class="l name">${swatch(x.teamId)}${esc(x.name)}</td>
          <td class="big">${fmtL(x.liters)}</td><td>${fmtL(x.perHead)}</td></tr>`).join('')}
      </table></div>
      <h3>Einzelwertung</h3>
      <div class="card"><table class="rank">
        ${r.liter.people.filter((p) => p.liters > 0).slice(0, 15).map((p) => `<tr>
          <td class="pl"><span class="medal">${medal(p.place)}</span></td>
          <td class="l name">${esc(p.name)}<div class="small muted">${swatch(p.teamId)}${esc(p.team)}</div></td>
          <td class="big">${fmtL(p.liters)} l</td></tr>`).join('') || '<tr><td class="l muted">Noch nichts getrunken 🙂</td></tr>'}
      </table></div>
      <p class="small muted">Insgesamt ${fmtL(r.liter.total)} Liter.</p>`;
    } else {
      html += `<div class="card"><table class="rank">
        <tr><th class="pl">Pl.</th><th class="l">Mannschaft</th><th>Sport</th><th>Liter</th><th>Summe</th></tr>
        ${r.overall.map((x) => `<tr>
          <td class="pl"><span class="medal">${medal(x.place)}</span></td>
          <td class="l name">${swatch(x.teamId)}${esc(x.name)}</td>
          <td>${x.sportPlace}.</td><td>${x.literPlace}.</td><td class="big">${x.sum}</td></tr>`).join('')}
      </table></div>
      <p class="small muted">Gesamtwertung: Platz Sport + Platz Liter. Die kleinste Summe gewinnt,
        bei Gleichstand zählt der bessere Sportplatz.</p>`;
    }
    return html;
  }

  // ------------------------------------------------------------ Spiele

  function gameStatus(g) {
    if (g.done) return '<span class="badge done">Beendet</span>';
    if ((g.kehren || []).some((k) => k && k.team)) return '<span class="badge live">Läuft</span>';
    return '<span class="badge">Offen</span>';
  }

  function viewGames() {
    const games = S.data.games;
    if (!games.length) {
      return localBanner() + '<div class="empty"><div class="big">📋</div>Noch kein Spielplan.<br><a href="#verwaltung">Im Setup erstellen</a></div>';
    }
    const rounds = new Map();
    for (const g of games) {
      if (!rounds.has(g.round)) rounds.set(g.round, []);
      rounds.get(g.round).push(g);
    }
    const playing = new Set(S.data.teams.map((t) => t.id));
    let html = localBanner();
    for (const [round, list] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
      const inRound = new Set(list.flatMap((g) => [g.teamA, g.teamB]));
      const bye = [...playing].filter((id) => !inRound.has(id));
      const doneCount = list.filter((g) => g.done).length;
      html += `<div class="round-title"><h3>Runde ${round}</h3><span class="small muted">${doneCount}/${list.length}</span></div>`;
      for (const g of list) {
        const s = scoring.gameScore(g);
        const any = (g.kehren || []).some((k) => k && k.team);
        const winA = g.done && s.a > s.b;
        const winB = g.done && s.b > s.a;
        html += `<a class="game" href="#spiel/${g.id}">
          <div class="ta ${winA ? 'winner' : ''}">${esc(teamName(g.teamA))} ${swatch(g.teamA)}</div>
          <div class="score">${any || g.done ? `${s.a} : ${s.b}` : '– : –'}</div>
          <div class="tb ${winB ? 'winner' : ''}">${swatch(g.teamB)} ${esc(teamName(g.teamB))}</div>
          <div class="meta"><span>Bahn ${g.bahn}</span>${gameStatus(g)}</div></a>`;
      }
      if (bye.length) html += `<p class="small muted">Spielfrei: ${bye.map((id) => esc(teamName(id))).join(', ')}</p>`;
    }
    return html;
  }

  function kehrenOf(g) {
    const n = Math.max(S.data.settings.kehren, (g.kehren || []).length);
    return Array.from({ length: n }, (_, i) => (g.kehren && g.kehren[i]) || { team: null, stocks: 0 });
  }

  function viewGame(id) {
    const g = S.data.games.find((x) => x.id === id);
    if (!g) return '<div class="empty">Spiel nicht gefunden. <a href="#spiele">Zurück</a></div>';
    const s = scoring.gameScore(g);
    const kehren = kehrenOf(g);
    const maxStocks = S.data.settings.stocks;
    const nameA = teamName(g.teamA);
    const nameB = teamName(g.teamB);
    let html = `<div class="row" style="justify-content:space-between">
        <a href="#spiele" class="btn sm">‹ Spiele</a>
        <span class="small muted">Runde ${g.round} · Bahn ${g.bahn}</span> ${gameStatus(g)}</div>
      <div class="scorehead">
        <div class="n">${swatch(g.teamA)}${esc(nameA)}</div>
        <div class="s">${s.a} : ${s.b}</div>
        <div class="n">${swatch(g.teamB)}${esc(nameB)}</div>
      </div>`;
    kehren.forEach((k, i) => {
      const pts = scoring.kehrePoints(k.stocks);
      const who = k.team === 'a' ? nameA : k.team === 'b' ? nameB : null;
      html += `<div class="kehre">
        <div class="kehre-head"><b>Kehre ${i + 1}</b>
          <span>${who ? `${esc(who)} +${pts}` : k.team === 'x' ? 'Keine Wertung (0:0)' : 'Wer liegt näher an der Daube?'}</span></div>
        <div class="pick">
          <button data-act="kehre" data-g="${g.id}" data-i="${i}" data-team="a" class="${k.team === 'a' ? 'on' : ''}">${esc(nameA)}</button>
          <button data-act="kehre" data-g="${g.id}" data-i="${i}" data-team="x" class="${k.team === 'x' ? 'on' : ''}" title="Kehre ohne Wertung">0</button>
          <button data-act="kehre" data-g="${g.id}" data-i="${i}" data-team="b" class="${k.team === 'b' ? 'on' : ''}">${esc(nameB)}</button>
        </div>
        ${k.team === 'a' || k.team === 'b' ? `<div class="stocks"><span class="lbl">Stöcke</span>
          ${Array.from({ length: maxStocks }, (_, j) => j + 1).map((n) =>
            `<button data-act="stocks" data-g="${g.id}" data-i="${i}" data-n="${n}" class="${k.stocks === n ? 'on' : ''}">${n}<span class="small"> (${scoring.kehrePoints(n)})</span></button>`).join('')}
        </div>` : ''}
      </div>`;
    });
    html += `<div class="row" style="margin-top:12px">
        <button class="btn sm" data-act="kehre-add" data-g="${g.id}">+ Kehre</button>
        ${kehren.length > S.data.settings.kehren ? `<button class="btn sm" data-act="kehre-remove" data-g="${g.id}">− Kehre</button>` : ''}
      </div>
      <div style="margin-top:12px">${g.done
        ? `<button class="btn block" data-act="done" data-g="${g.id}" data-v="0">Spiel wieder öffnen</button>`
        : `<button class="btn primary block" data-act="done" data-g="${g.id}" data-v="1">✓ Spiel beenden &amp; werten</button>`}</div>
      <p class="small muted">Tippe die Mannschaft an, deren Stock am nächsten an der Daube liegt, dann die Anzahl ihrer Stöcke,
        die näher liegen als der beste gegnerische Stock. Erst beendete Spiele zählen für die Rangliste.</p>`;
    return html;
  }

  async function updateGame(id, mutate) {
    const g = S.data.games.find((x) => x.id === id);
    if (!g) return;
    const next = { ...g, kehren: kehrenOf(g).map((k) => ({ ...k })) };
    mutate(next);
    Object.assign(g, next); // optimistisch anzeigen
    render();
    await write((pin) => S.api.saveGame(pin, next));
  }

  // ------------------------------------------------------------ Liter

  function viewLiter() {
    if (!S.data.teams.length) {
      return localBanner() + '<div class="empty"><div class="big">🍺</div>Noch keine Mannschaften.<br><a href="#verwaltung">Im Setup anlegen</a></div>';
    }
    const r = scoring.literRanking(S.data);
    const byPerson = new Map(r.people.map((p) => [p.personId, p.liters]));
    const q = S.literSearch.trim().toLowerCase();
    let html = localBanner() + `<input type="text" id="litersearch" placeholder="🔍 Name suchen" value="${esc(S.literSearch)}" style="margin-bottom:12px">`;
    for (const t of S.data.teams) {
      const members = t.members.filter((m) => !q || m.name.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
      if (!members.length) continue;
      const tl = r.teams.find((x) => x.teamId === t.id);
      html += `<div class="card"><div class="team-head"><b>${swatch(t.id)}${esc(t.name)}</b><span class="small muted">${fmtL(tl.liters)} l</span></div>`;
      for (const m of members) {
        html += `<div class="person"><div class="who"><b>${esc(m.name)}</b><span>${fmtL(byPerson.get(m.id))} l</span></div>
          ${DRINKS.map((l) => `<button class="btn add" data-act="drink" data-p="${m.id}" data-l="${l}">+${fmtL(l)}</button>`).join('')}
          <button class="btn add" data-act="drink-custom" data-p="${m.id}" title="Andere Menge">…</button></div>`;
      }
      html += '</div>';
    }
    const names = new Map(S.data.teams.flatMap((t) => t.members.map((m) => [m.id, m.name])));
    const recent = S.data.drinks.slice(-8).reverse();
    if (recent.length) {
      html += `<h3>Letzte Einträge</h3><div class="card"><ul class="list-plain">${recent.map((d) => `<li>
        <span>${esc(names.get(d.personId) || '?')} <b>+${fmtL(d.liters)} l</b>
          <span class="small muted">${new Date(d.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span></span>
        <button class="btn sm danger" data-act="drink-del" data-id="${d.id}">Löschen</button></li>`).join('')}</ul></div>`;
    }
    return html;
  }

  async function addDrink(personId, liters) {
    const before = new Set(S.data.drinks.map((d) => d.id));
    const ok = await write((pin) => S.api.addDrink(pin, personId, liters));
    if (!ok) return;
    const added = S.data.drinks.find((d) => !before.has(d.id) && d.personId === personId);
    const name = (S.data.teams.flatMap((t) => t.members).find((m) => m.id === personId) || {}).name;
    toast(`+${fmtL(liters)} l für ${name} 🍺`, {
      undo: added ? () => write((pin) => S.api.deleteDrink(pin, added.id)) : null,
    });
  }

  // ------------------------------------------------------------ Verwaltung

  function viewAdmin() {
    const st = S.data.settings;
    const c = connection();
    let html = localBanner() + '<h2>Setup</h2>';

    html += `<div class="card"><h3 style="margin-top:0">Turnier</h3>
      <label class="field"><span>Titel</span><input type="text" id="set-title" value="${esc(st.title)}"></label>
      <div class="row">
        <label class="field grow"><span>Kehren pro Spiel</span><input type="number" id="set-kehren" min="1" max="12" value="${st.kehren}"></label>
        <label class="field grow"><span>Stöcke pro Mannschaft</span><input type="number" id="set-stocks" min="1" max="8" value="${st.stocks}"></label>
      </div>
      <button class="btn primary" data-act="settings-save">Speichern</button></div>`;

    html += `<h3>Mannschaften (${S.data.teams.length})</h3>`;
    for (const t of S.data.teams) html += teamEditor(t);
    html += `<button class="btn block" data-act="team-new">+ Mannschaft hinzufügen</button>`;

    html += `<h3>Spielplan</h3><div class="card">
      <p class="small muted">Erstellt einen Spielplan „Jeder gegen Jeden“ mit Runden und Bahnen.
        ${S.data.teams.length} Mannschaften → ${schedule.roundRobin(S.data.teams.map((t) => t.id)).length} Spiele.</p>
      <button class="btn primary block" data-act="schedule" ${S.data.teams.length < 2 ? 'disabled' : ''}>Spielplan erstellen</button>
      <details style="margin-top:12px"><summary>Einzelnes Spiel hinzufügen</summary>
        <div class="row" style="margin-top:8px">
          <select id="ng-a" class="grow">${S.data.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
          <span>vs</span>
          <select id="ng-b" class="grow">${S.data.teams.map((t, i) => `<option value="${t.id}" ${i === 1 ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        </div>
        <div class="row" style="margin-top:8px">
          <label class="field grow"><span>Runde</span><input type="number" id="ng-round" min="1" value="${Math.max(1, ...S.data.games.map((g) => g.round))}"></label>
          <label class="field grow"><span>Bahn</span><input type="number" id="ng-bahn" min="1" value="1"></label>
        </div>
        <button class="btn block" data-act="game-add">Spiel hinzufügen</button>
      </details>
      ${S.data.games.length ? `<details style="margin-top:12px"><summary>Spiele löschen</summary><ul class="list-plain">
        ${S.data.games.map((g) => `<li><span class="small">R${g.round}/B${g.bahn}: ${esc(teamName(g.teamA))} – ${esc(teamName(g.teamB))}</span>
          <button class="btn sm danger" data-act="game-del" data-id="${g.id}">✕</button></li>`).join('')}</ul></details>` : ''}
    </div>`;

    html += `<h3>Daten</h3><div class="card"><div class="row">
      <button class="btn grow" data-act="export">⬇️ Export (JSON)</button>
      <button class="btn danger grow" data-act="reset-results">Ergebnisse &amp; Liter löschen</button>
      <button class="btn danger grow" data-act="reset-all">Alles löschen</button></div></div>`;

    html += `<h3>Verbindung</h3><div class="card">
      <p class="small">${c
        ? `✅ Supabase verbunden <span class="muted">(${esc(c.url.replace(/^https?:\/\//, ''))}${c.source === 'gerät' ? ', nur auf diesem Gerät eingestellt' : ''})</span>`
        : '⚠️ Lokaler Modus – keine gemeinsame Datenbank.'}</p>
      ${S.api.needsPin ? `<p class="small">${S.pin ? '🔓 Schreibzugriff entsperrt.' : '🔒 Nur Lesen – zum Eintragen PIN eingeben.'}</p>
        <div class="row">${S.pin ? '<button class="btn sm" data-act="lock">Sperren</button>' : '<button class="btn sm primary" data-act="unlock">PIN eingeben</button>'}</div>` : ''}
      <details style="margin-top:10px"><summary class="small">Verbindung manuell einstellen</summary>
        <p class="small muted">Normalerweise kommt die Verbindung automatisch aus dem GitHub-Deployment.
          Hier kann sie für dieses Gerät überschrieben werden (z. B. zum Testen).</p>
        <label class="field"><span>Supabase URL</span><input type="url" id="conn-url" placeholder="https://xyz.supabase.co" value="${esc(c && c.source === 'gerät' ? c.url : '')}"></label>
        <label class="field"><span>Publishable / anon Key</span><input type="text" id="conn-key" value="${esc(c && c.source === 'gerät' ? c.key : '')}"></label>
        <div class="row"><button class="btn sm primary" data-act="conn-save">Übernehmen</button>
          <button class="btn sm" data-act="conn-clear">Zurücksetzen</button></div>
      </details></div>`;
    return html;
  }

  function teamEditor(t) {
    return `<div class="card" data-team="${t.id}">
      <div class="row"><span>${swatch(t.id)}</span>
        <input type="text" class="grow" data-field="name" value="${esc(t.name)}" placeholder="Mannschaftsname"></div>
      <div style="margin:10px 0 6px" class="small muted">Mitspieler</div>
      <div data-members>${t.members.map((m) => memberRow(m)).join('')}</div>
      <div class="row" style="margin-top:6px">
        <button class="btn sm" data-act="member-add">+ Person</button>
        <span class="grow"></span>
        <button class="btn sm danger" data-act="team-del" data-id="${t.id}">Löschen</button>
        <button class="btn sm primary" data-act="team-save">Speichern</button>
      </div></div>`;
  }

  function memberRow(m) {
    return `<div class="member" data-mid="${esc(m.id)}"><input type="text" value="${esc(m.name)}" placeholder="Name">
      <button class="iconbtn" data-act="member-del" title="Entfernen">✕</button></div>`;
  }

  function readTeamCard(card) {
    const name = card.querySelector('[data-field=name]').value.trim();
    const members = [...card.querySelectorAll('[data-members] .member')]
      .map((row) => ({ id: row.dataset.mid, name: row.querySelector('input').value.trim() }))
      .filter((m) => m.name);
    return { id: card.dataset.team === 'new' ? null : card.dataset.team, name, members };
  }

  // ------------------------------------------------------------ Regeln

  function viewRules() {
    const st = S.data.settings;
    return `<div class="rules"><h2>So wird gewertet</h2>
      <div class="card">
        <h4>🥌 Ein Spiel</h4>
        <p>Zwei Mannschaften spielen gegeneinander, ein Spiel hat <b>${st.kehren} Kehren</b> (Durchgänge).
          Pro Kehre schießt jede Mannschaft ihre ${st.stocks} Stöcke Richtung Daube (Zielwürfel).</p>
        <h4>📏 Punkte pro Kehre</h4>
        <p>Nur die Mannschaft, deren Stock <b>am nächsten an der Daube</b> liegt, bekommt Punkte:</p>
        <ul><li>bester Stock: <b>3 Punkte</b></li>
          <li>jeder weitere eigene Stock, der näher liegt als der beste gegnerische: <b>+2 Punkte</b></li></ul>
        <table><tr><th>Stöcke</th>${Array.from({ length: st.stocks }, (_, i) => `<td>${i + 1}</td>`).join('')}</tr>
          <tr><th>Punkte</th>${Array.from({ length: st.stocks }, (_, i) => `<td>${scoring.kehrePoints(i + 1)}</td>`).join('')}</tr></table>
        <p class="small muted">Liegt kein Stock im Feld oder ist es nicht zu entscheiden, wird die Kehre mit „0“ gewertet.</p>
        <h4>🏁 Spielergebnis</h4>
        <p>Die Stockpunkte aller Kehren werden addiert. Wer mehr hat, gewinnt:
          <b>Sieg = 2</b>, <b>Unentschieden = 1</b>, <b>Niederlage = 0</b> Spielpunkte.</p>
      </div>
      <div class="card">
        <h4>🏆 Sportwertung</h4>
        <ol><li>Spielpunkte</li>
          <li><b>Stocknote</b> = erzielte ÷ erhaltene Stockpunkte (wie bei offiziellen Turnieren)</li>
          <li>Stockpunkte-Differenz</li><li>mehr erzielte Stockpunkte</li></ol>
        <p class="small muted">Gespielt wird „Jeder gegen Jeden“. Nur beendete Spiele zählen.</p>
      </div>
      <div class="card">
        <h4>🍺 Literwertung</h4>
        <p>Jedes Getränk wird per Knopfdruck pro Person eingetragen.
          Mannschaften werden nach <b>Gesamtlitern</b> gereiht (Ø pro Kopf steht daneben), dazu gibt es eine Einzelwertung.</p>
        <h4>⭐ Gesamtwertung</h4>
        <p>Platz in der Sportwertung + Platz in der Literwertung. <b>Die kleinste Summe gewinnt</b>,
          bei Gleichstand entscheidet der Sportplatz.</p>
        <p class="small muted">Bitte verantwortungsvoll trinken – und nach dem Eisstockschießen nicht mehr selbst fahren. 🚕</p>
      </div></div>`;
  }

  // ------------------------------------------------------------ Aktionen

  const actions = {
    'ranktab': (el) => { S.rankTab = el.dataset.k; lsSet(LS.rank, S.rankTab); render(); },
    'toast-undo': () => { const u = toast.undo; $('#toast').hidden = true; if (u) u(); },
    'modal-close': () => { modal(null); if (askPin.resolve) askPin.resolve(false); },

    'kehre': (el) => updateGame(el.dataset.g, (g) => {
      const k = g.kehren[+el.dataset.i];
      const team = el.dataset.team;
      if (k.team === team) { k.team = null; k.stocks = 0; } // nochmal tippen = zurücksetzen
      else { k.team = team; k.stocks = team === 'x' ? 0 : (k.stocks || 1); }
    }),
    'stocks': (el) => updateGame(el.dataset.g, (g) => { g.kehren[+el.dataset.i].stocks = +el.dataset.n; }),
    'kehre-add': (el) => updateGame(el.dataset.g, (g) => { g.kehren.push({ team: null, stocks: 0 }); }),
    'kehre-remove': (el) => updateGame(el.dataset.g, (g) => { g.kehren.pop(); }),
    'done': async (el) => {
      const g = S.data.games.find((x) => x.id === el.dataset.g);
      const done = el.dataset.v === '1';
      if (done && !g.kehren.some((k) => k && k.team) && !confirm('Es wurde noch keine Kehre eingetragen. Trotzdem beenden?')) return;
      if (await write((pin) => S.api.saveGame(pin, { ...g, done })) && done) {
        toast('Spiel gewertet ✓');
        location.hash = '#spiele';
      }
    },

    'drink': (el) => addDrink(el.dataset.p, Number(el.dataset.l)),
    'drink-custom': (el) => {
      const v = prompt('Menge in Litern (z. B. 0,25):', '0,25');
      if (v == null) return;
      const l = Number(String(v).replace(',', '.'));
      if (!(l > 0 && l <= 5)) { toast('Ungültige Menge', { error: true }); return; }
      addDrink(el.dataset.p, Math.round(l * 100) / 100);
    },
    'drink-del': (el) => write((pin) => S.api.deleteDrink(pin, el.dataset.id)),

    'settings-save': () => {
      const kehren = Math.min(12, Math.max(1, parseInt($('#set-kehren').value, 10) || 6));
      const stocks = Math.min(8, Math.max(1, parseInt($('#set-stocks').value, 10) || 4));
      const title = $('#set-title').value.trim() || B.DEFAULT_SETTINGS.title;
      document.activeElement.blur();
      write((pin) => S.api.saveSettings(pin, { title, kehren, stocks })).then((ok) => ok && toast('Gespeichert ✓'));
    },
    'team-new': () => {
      const n = S.data.teams.length + 1;
      const html = teamEditor({ id: 'new', name: '', members: [] });
      const btn = document.querySelector('[data-act=team-new]');
      if (document.querySelector('[data-team=new]')) return;
      btn.insertAdjacentHTML('beforebegin', html);
      const card = document.querySelector('[data-team=new]');
      card.querySelector('[data-act=team-del]').remove();
      const input = card.querySelector('[data-field=name]');
      input.placeholder = 'Mannschaft ' + n;
      for (let i = 0; i < 4; i++) card.querySelector('[data-members]').insertAdjacentHTML('beforeend', memberRow({ id: B.uuid(), name: '' }));
      input.focus();
    },
    'member-add': (el) => {
      const box = el.closest('[data-team]').querySelector('[data-members]');
      box.insertAdjacentHTML('beforeend', memberRow({ id: B.uuid(), name: '' }));
      box.lastElementChild.querySelector('input').focus();
    },
    'member-del': (el) => el.closest('.member').remove(),
    'team-save': (el) => {
      const t = readTeamCard(el.closest('[data-team]'));
      if (!t.name) t.name = el.closest('[data-team]').querySelector('[data-field=name]').placeholder || 'Mannschaft';
      document.activeElement.blur();
      write((pin) => S.api.saveTeam(pin, t)).then((ok) => ok && toast('Mannschaft gespeichert ✓'));
    },
    'team-del': (el) => {
      if (!confirm('Mannschaft inkl. ihrer Spiele und Liter löschen?')) return;
      write((pin) => S.api.deleteTeam(pin, el.dataset.id));
    },
    'schedule': () => {
      const hasResults = S.data.games.some((g) => g.done || (g.kehren || []).some((k) => k && k.team));
      if (S.data.games.length && !confirm(hasResults
        ? 'Achtung: Es gibt schon Ergebnisse! Der neue Spielplan ersetzt alle Spiele inkl. Ergebnisse. Fortfahren?'
        : 'Bestehenden Spielplan ersetzen?')) return;
      const ids = S.data.teams.map((t) => t.id);
      // Zufällige Reihenfolge, damit der Spielplan nicht von der Eingabereihenfolge abhängt
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      write((pin) => S.api.setSchedule(pin, schedule.roundRobin(ids))).then((ok) => {
        if (ok) { toast('Spielplan erstellt ✓'); location.hash = '#spiele'; }
      });
    },
    'game-add': () => {
      const a = $('#ng-a').value;
      const b = $('#ng-b').value;
      if (a === b) { toast('Zwei verschiedene Mannschaften wählen', { error: true }); return; }
      const g = { teamA: a, teamB: b, round: parseInt($('#ng-round').value, 10) || 1, bahn: parseInt($('#ng-bahn').value, 10) || 1 };
      document.activeElement.blur();
      write((pin) => S.api.addGame(pin, g)).then((ok) => ok && toast('Spiel hinzugefügt ✓'));
    },
    'game-del': (el) => confirm('Spiel löschen?') && write((pin) => S.api.deleteGame(pin, el.dataset.id)),
    'export': () => {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...S.data, rankings: scoring.rankings(S.data) }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'eisstock-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    'reset-results': () => confirm('Alle Spiele und Liter löschen? Mannschaften bleiben erhalten.') &&
      write((pin) => S.api.reset(pin, true)),
    'reset-all': () => confirm('Wirklich ALLES löschen (Mannschaften, Spiele, Liter)?') &&
      write((pin) => S.api.reset(pin, false)),
    'unlock': () => askPin(),
    'lock': () => { S.pin = ''; lsSet(LS.pin, null); render(); },
    'conn-save': () => {
      const url = $('#conn-url').value.trim();
      const key = $('#conn-key').value.trim();
      if (!/^https:\/\//.test(url) || !key) { toast('URL (https://…) und Key angeben', { error: true }); return; }
      lsSet(LS.conn, JSON.stringify({ url, key }));
      location.reload();
    },
    'conn-clear': () => { lsSet(LS.conn, null); location.reload(); },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    ev.preventDefault();
    fn(el);
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'litersearch') {
      S.literSearch = ev.target.value;
      render();
    }
  });

  // Aufgeschobenes Neuzeichnen nachholen, sobald ein Feld verlassen wird.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if (S.renderPending && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName))) render();
    }, 0);
  });

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  initApi();
  render();
  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
})();
