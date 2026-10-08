(function () {
  'use strict';

  const { scoring, schedule, backend: B } = window.Eisstock;
  const POLL_MS = 4000;
  const UNDO_MINUTES = 5; // muss zu delete_drink in supabase/setup.sql passen
  const LS = { auth: 'eisstock.auth', conn: 'eisstock.connection', local: 'eisstock.localdata', rank: 'eisstock.ranktab' };
  const COLORS = ['#d33a2c', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22', '#7f7f7f'];
  const DRINKS = [0.33, 0.5]; // Flaschen bzw. Halbe – mehr gibt es nicht
  const SOURCE = { user: '👤', bar: '🍺', admin: '⚙️' };
  const SOURCE_TITLE = { user: 'selbst eingetragen', bar: 'von der Bar', admin: 'vom Admin' };

  const S = {
    api: null,
    data: { settings: { ...B.DEFAULT_SETTINGS }, teams: [], players: [], games: [], drinks: [] },
    dataJson: '',
    loaded: false,
    online: true,
    auth: readAuth(), // { secret, role: 'admin'|'bar'|'user', playerId }
    rankTab: lsGet(LS.rank) || 'sport',
    literSearch: '',
    reg: { code: '', team: null, player: null, name: '', err: '' }, // Registrierungsformular überlebt Neuzeichnen
    renderPending: false,
  };

  // ------------------------------------------------------------ Hilfen

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* egal */ } }
  function readAuth() { try { return JSON.parse(lsGet(LS.auth)) || null; } catch (e) { return null; } }
  function setAuth(a) { S.auth = a; lsSet(LS.auth, a ? JSON.stringify(a) : null); }

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtL = (x) => Number(x || 0).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  const fmtNum = (x) => Number(x || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtNote = (r) => (r.stocknote === null ? '∞' : r.stocknote.toLocaleString('de-DE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
  const medal = (p) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[p] || p + '.');
  const team = (id) => S.data.teams.find((t) => t.id === id);
  const teamName = (id) => (team(id) || { name: '?' }).name;
  const player = (id) => S.data.players.find((p) => p.id === id);
  const teamColor = (id) => COLORS[Math.max(0, S.data.teams.findIndex((t) => t.id === id)) % COLORS.length];
  const swatch = (id) => (team(id) ? `<span class="swatch" style="background:${teamColor(id)}"></span>` : '');

  const role = () => (S.auth && S.auth.role) || null;
  const isAdmin = () => role() === 'admin';
  const canBar = () => role() === 'admin' || role() === 'bar';
  const myId = () => (role() === 'user' ? S.auth.playerId : null);

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
    if (S.api.kind === 'local') S.auth = { secret: 'local', role: 'admin', playerId: null };
  }

  let toastTimer;
  function toast(msg, opts = {}) {
    const el = $('#toast');
    el.className = 'toast' + (opts.error ? ' err' : '');
    el.innerHTML = `<span>${esc(msg)}</span>` + (opts.undo ? '<button data-act="toast-undo">Rückgängig</button>' : '');
    el.hidden = false;
    toast.undo = opts.undo || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; toast.undo = null; }, opts.undo || opts.error ? 6000 : 2800);
  }

  // ------------------------------------------------------------ Daten laden / schreiben

  async function refresh(force) {
    try {
      const data = await S.api.load();
      const json = JSON.stringify(data);
      S.online = true;
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

  // Login beim Start prüfen (z. B. wurde er vom Admin zurückgesetzt oder der Code geändert).
  async function verifyAuth() {
    if (S.api.kind === 'local' || !S.auth) return;
    try {
      const r = await S.api.login(S.auth.secret);
      setAuth({ ...S.auth, role: r.role, playerId: r.playerId });
    } catch (e) {
      if (/Ungültig|abgemeldet/i.test(e.message)) {
        setAuth(null);
        toast('Du wurdest abgemeldet. Bitte neu anmelden.', { error: true });
      }
    }
    render();
  }

  // Führt eine Schreibaktion aus und lädt danach IMMER die echten Daten neu –
  // auch bei Fehlern, damit keine nur lokal geänderten Werte stehen bleiben.
  async function write(fn) {
    if (!S.auth) {
      toast('Bitte zuerst anmelden.', { error: true });
      location.hash = '#konto';
      await refresh(true);
      return false;
    }
    try {
      const result = await fn(S.auth.secret);
      await refresh(true);
      return result ?? true;
    } catch (e) {
      if (/Ungültiger Code oder abgemeldet/.test(e.message)) {
        setAuth(null);
        toast('Du bist nicht mehr angemeldet. Bitte neu anmelden.', { error: true });
      } else {
        toast(e.message, { error: true });
      }
      await refresh(true);
      return false;
    }
  }

  // ------------------------------------------------------------ Routing / Rendering

  function route() {
    const h = location.hash.replace(/^#/, '') || 'rangliste';
    const [view, arg] = h.split('/');
    return { view: view === 'verwaltung' ? 'konto' : view, arg };
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
    const title = S.data.settings.title || 'Eisstock-Rangliste';
    document.title = title;
    $('#title').textContent = title;
    const tab = view === 'spiel' ? 'spiele' : view;
    document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const kontoTab = $('#tabbar a[data-tab=konto]');
    kontoTab.innerHTML = isAdmin() ? '<span class="ico">⚙️</span>Setup'
      : S.auth ? '<span class="ico">👤</span>Ich' : '<span class="ico">👤</span>Anmelden';
    const views = { rangliste: viewRank, spiele: viewGames, spiel: viewGame, liter: viewLiter, konto: viewKonto, regeln: viewRules };
    const main = $('#main');
    const scroll = window.scrollY;
    const keepFocus = ae && ae.id === 'litersearch' ? ae.selectionStart : null;
    main.innerHTML = (S.loaded || S.api.kind === 'local' ? '' : '<div class="empty">Lade …</div>') + (views[view] || viewRank)(arg);
    if (keepFocus !== null) {
      const s = $('#litersearch');
      if (s) { s.focus(); s.setSelectionRange(keepFocus, keepFocus); }
    }
    if (view === 'konto') fillRegPlayers();
    window.scrollTo(0, scroll);
    renderStatus();
  }

  function renderStatus() {
    const el = $('#status');
    const who = isAdmin() ? 'Admin' : role() === 'bar' ? 'Bar' : myId() ? (player(myId()) || {}).name || 'Ich' : '';
    if (S.api.kind === 'local') {
      el.innerHTML = '<span class="dot off"></span>Lokal';
    } else if (!S.online) {
      el.innerHTML = '<span class="dot err"></span>Offline';
    } else {
      el.innerHTML = `<span class="dot"></span>Live${who ? ' · ' + esc(who) : ''}`;
    }
  }

  function localBanner() {
    return S.api.kind === 'local'
      ? '<div class="banner">⚠️ <b>Lokaler Modus:</b> Daten liegen nur auf diesem Gerät. Für gemeinsame Daten auf allen Handys Supabase verbinden (siehe README).</div>'
      : '';
  }

  // ------------------------------------------------------------ Rangliste

  function viewRank() {
    const r = scoring.rankings(S.data);
    if (!S.data.teams.length) {
      return localBanner() + `<div class="empty"><div class="big">🥌</div>Noch keine Mannschaften.<br>
        ${isAdmin() ? '<a href="#konto">Jetzt im Setup anlegen</a>' : 'Der Admin legt sie gleich an.'}</div>`;
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
        ${r.liter.people.filter((p) => p.liters > 0).slice(0, 15).map((p) => `<tr class="${p.personId === myId() ? 'me' : ''}">
          <td class="pl"><span class="medal">${medal(p.place)}</span></td>
          <td class="l name">${esc(p.name)}<div class="small muted">${swatch(p.teamId)}${esc(p.team || 'ohne Mannschaft')}</div></td>
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
      return localBanner() + `<div class="empty"><div class="big">📋</div>Noch kein Spielplan.<br>
        ${isAdmin() ? '<a href="#konto">Im Setup erstellen</a>' : 'Der Admin erstellt ihn gleich.'}</div>`;
    }
    const rounds = new Map();
    for (const g of games) {
      if (!rounds.has(g.round)) rounds.set(g.round, []);
      rounds.get(g.round).push(g);
    }
    const allTeams = S.data.teams.map((t) => t.id);
    let html = localBanner();
    for (const [round, list] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
      const inRound = new Set(list.flatMap((g) => [g.teamA, g.teamB]));
      const bye = allTeams.filter((id) => !inRound.has(id));
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
    const nameA = teamName(g.teamA);
    const nameB = teamName(g.teamB);
    const edit = isAdmin();
    let html = `<div class="row" style="justify-content:space-between">
        <a href="#spiele" class="btn sm">‹ Spiele</a>
        <span class="small muted">Runde ${g.round} · Bahn ${g.bahn}</span> ${gameStatus(g)}</div>
      <div class="scorehead">
        <div class="n">${swatch(g.teamA)}${esc(nameA)}</div>
        <div class="s">${s.a} : ${s.b}</div>
        <div class="n">${swatch(g.teamB)}${esc(nameB)}</div>
      </div>`;

    if (!edit) {
      html += `<div class="card"><ul class="list-plain">${kehren.map((k, i) => {
        const who = k.team === 'a' ? nameA : k.team === 'b' ? nameB : null;
        return `<li><span>Kehre ${i + 1}</span><span>${who ? `<b>${esc(who)}</b> +${scoring.kehrePoints(k.stocks)}`
          : k.team === 'x' ? '0 : 0' : '<span class="muted">–</span>'}</span></li>`;
      }).join('')}</ul></div>
      <p class="small muted">Ergebnisse trägt der Admin ein. Die Anzeige aktualisiert sich automatisch.</p>`;
      return html;
    }

    const maxStocks = S.data.settings.stocks;
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
    if (!isAdmin()) return;
    const g = S.data.games.find((x) => x.id === id);
    if (!g) return;
    const next = { ...g, kehren: kehrenOf(g).map((k) => ({ ...k })) };
    mutate(next);
    Object.assign(g, next); // sofort anzeigen; write() lädt danach den echten Stand
    render();
    await write((secret) => S.api.saveGame(secret, next));
  }

  // ------------------------------------------------------------ Liter

  // Was darf die angemeldete Person gerade selbst eintragen? (Server prüft dasselbe verbindlich.)
  function selfEntryState() {
    const st = S.data.settings;
    const mine = S.data.drinks.filter((d) => d.personId === myId());
    const now = Date.now();
    const last = mine.reduce((m, d) => Math.max(m, Date.parse(d.createdAt)), 0);
    const waitMs = last ? last + st.userMinGap * 60000 - now : 0;
    const hour = mine.filter((d) => Date.parse(d.createdAt) > now - 3600000).reduce((s, d) => s + d.liters, 0);
    const undo = mine.filter((d) => d.enteredBy === 'user' && Date.parse(d.createdAt) > now - UNDO_MINUTES * 60000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    let blocked = '';
    if (!st.selfEntry) blocked = 'Selbst eintragen ist gerade gesperrt – bitte an der Bar eintragen lassen.';
    else if (waitMs > 0) blocked = `⏳ Nächster Eintrag in ${Math.ceil(waitMs / 60000)} Min. möglich.`;
    return { total: mine.reduce((s, d) => s + d.liters, 0), hour, blocked, undo };
  }

  function viewLiter() {
    if (!S.data.players.length) {
      return localBanner() + `<div class="empty"><div class="big">🍺</div>Noch niemand dabei.<br>
        ${S.auth ? '' : '<a href="#konto">Jetzt registrieren</a>'}</div>`;
    }
    const st = S.data.settings;
    const r = scoring.literRanking(S.data);
    const byPerson = new Map(r.people.map((p) => [p.personId, p.liters]));
    let html = localBanner();

    if (!S.auth) {
      html += '<div class="banner">👤 <a href="#konto">Registriere dich</a>, um deine eigenen Liter einzutragen.</div>';
    } else if (myId()) {
      const me = selfEntryState();
      const sizes = DRINKS.filter((l) => l <= st.userMaxEntry);
      html += `<div class="card mycard">
        <div class="team-head"><b>🍺 Meine Liter</b><span class="big">${fmtL(me.total)} l</span></div>
        <div class="row" style="margin:10px 0 6px">${sizes.map((l) =>
          `<button class="btn grow" data-act="drink" data-p="${esc(myId())}" data-l="${l}" ${me.blocked ? 'disabled' : ''}>+${fmtL(l)} l</button>`).join('')}</div>
        <p class="small ${me.blocked ? '' : 'muted'}">${me.blocked ||
          `Letzte Stunde: ${fmtL(me.hour)} von max. ${fmtNum(st.userMaxPerHour)} l · mind. ${st.userMinGap} Min. Abstand`}</p>
        ${me.undo ? `<button class="btn sm" data-act="drink-del" data-id="${me.undo.id}">↶ Letzten Eintrag (+${fmtL(me.undo.liters)} l) zurücknehmen</button>` : ''}
      </div>`;
    } else {
      html += `<input type="text" id="litersearch" placeholder="🔍 Name suchen" value="${esc(S.literSearch)}" style="margin-bottom:12px">`;
    }

    const q = canBar() ? S.literSearch.trim().toLowerCase() : '';
    const groups = S.data.teams.map((t) => ({ id: t.id, name: t.name, members: S.data.players.filter((p) => p.teamId === t.id) }));
    const loose = S.data.players.filter((p) => !team(p.teamId));
    if (loose.length) groups.push({ id: null, name: 'Ohne Mannschaft', members: loose });

    for (const grp of groups) {
      const members = grp.members.filter((m) => !q || m.name.toLowerCase().includes(q) || grp.name.toLowerCase().includes(q));
      if (!members.length) continue;
      const tl = grp.id ? r.teams.find((x) => x.teamId === grp.id).liters : null;
      html += `<div class="card"><div class="team-head"><b>${swatch(grp.id)}${esc(grp.name)}</b>
        <span class="small muted">${tl === null ? '' : fmtL(tl) + ' l'}</span></div>`;
      for (const m of members) {
        html += `<div class="person ${m.id === myId() ? 'me' : ''}"><div class="who"><b>${esc(m.name)}</b><span>${fmtL(byPerson.get(m.id))} l</span></div>
          ${canBar() ? DRINKS.map((l) => `<button class="btn add" data-act="drink" data-p="${esc(m.id)}" data-l="${l}">+${fmtL(l)}</button>`).join('') : ''}
        </div>`;
      }
      html += '</div>';
    }

    const recent = S.data.drinks.slice(-(canBar() ? 15 : 8)).reverse();
    if (recent.length) {
      html += `<h3>Letzte Einträge</h3><div class="card"><ul class="list-plain">${recent.map((d) => {
        const mineUndo = myId() && d.personId === myId() && d.enteredBy === 'user' &&
          Date.parse(d.createdAt) > Date.now() - UNDO_MINUTES * 60000;
        return `<li><span>${esc((player(d.personId) || {}).name || '?')} <b>+${fmtL(d.liters)} l</b>
          <span class="small muted">${fmtTime(d.createdAt)} <span title="${SOURCE_TITLE[d.enteredBy] || ''}">${SOURCE[d.enteredBy] || ''}</span></span></span>
          ${canBar() || mineUndo ? `<button class="btn sm danger" data-act="drink-del" data-id="${d.id}">Löschen</button>` : ''}</li>`;
      }).join('')}</ul>
      <p class="small muted">👤 selbst eingetragen · 🍺 Bar · ⚙️ Admin</p></div>`;
    }
    return html;
  }

  async function addDrink(personId, liters) {
    const before = new Set(S.data.drinks.map((d) => d.id));
    const ok = await write((secret) => S.api.addDrink(secret, personId, liters));
    if (!ok) return;
    const added = S.data.drinks.find((d) => !before.has(d.id) && d.personId === personId);
    toast(`+${fmtL(liters)} l für ${(player(personId) || {}).name || '?'} 🍺`, {
      undo: added ? () => write((secret) => S.api.deleteDrink(secret, added.id)) : null,
    });
  }

  // ------------------------------------------------------------ Konto / Setup

  function viewKonto() {
    if (isAdmin()) return viewAdmin();
    let html = localBanner();
    if (role() === 'bar') {
      html += `<h2>🍺 Bar</h2><div class="card"><p>Du bist als <b>Bar</b> angemeldet und kannst unter
        <a href="#liter">Liter</a> für alle Personen eintragen und Einträge löschen.</p>
        <button class="btn" data-act="logout">Abmelden</button></div>`;
      return html + loginCard(true);
    }
    if (myId()) {
      const me = player(myId());
      const st = S.data.settings;
      html += `<h2>👤 ${esc(me ? me.name : 'Ich')}</h2><div class="card">
        <p>Mannschaft: <b>${me && team(me.teamId) ? swatch(me.teamId) + esc(teamName(me.teamId)) : 'noch keine – der Admin teilt dich ein'}</b></p>
        <p>Getrunken: <b>${fmtL(selfEntryState().total)} l</b> · <a href="#liter">Liter eintragen</a></p>
        <p class="small muted">Regeln fürs Selbst-Eintragen: höchstens ${fmtNum(st.userMaxEntry)} l pro Eintrag,
          mindestens ${st.userMinGap} Min. zwischen zwei Einträgen, max. ${fmtNum(st.userMaxPerHour)} l pro Stunde.
          Eigene Einträge lassen sich ${UNDO_MINUTES} Min. lang zurücknehmen; alles andere korrigiert die Bar.</p>
        <button class="btn danger" data-act="logout-user">Abmelden</button>
        <p class="small muted">Achtung: Nach dem Abmelden kann nur der Admin dein Konto wieder freigeben.</p></div>`;
      return html + loginCard(true);
    }

    const st = S.data.settings;
    html += '<h2>Anmelden</h2>';
    if (st.registrationOpen) {
      html += `<div class="card"><h3 style="margin-top:0">👤 Als Teilnehmer registrieren</h3>
        <form id="regform">
          <label class="field"><span>Teilnehmer-Code (bekommst du vom Organisator)</span>
            <input type="text" id="reg-code" autocomplete="off" autocapitalize="off" value="${esc(S.reg.code)}"></label>
          <label class="field"><span>Deine Mannschaft</span>
            <select id="reg-team">${S.data.teams.map((t) => `<option value="${t.id}" ${S.reg.team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              <option value="" ${S.reg.team === '' ? 'selected' : ''}>Noch keine / weiß ich nicht</option></select></label>
          <label class="field"><span>Wer bist du?</span><select id="reg-player"></select></label>
          <label class="field" id="reg-name-field"><span>Dein Name</span>
            <input type="text" id="reg-name" maxlength="40" autocomplete="name" placeholder="Vorname Nachname" value="${esc(S.reg.name)}"></label>
          <p class="small" id="reg-err" style="color:var(--accent)">${esc(S.reg.err)}</p>
          <button class="btn primary block">Registrieren</button>
        </form>
        <p class="small muted">Danach kannst du auf diesem Handy deine eigenen Liter eintragen.</p></div>`;
    } else {
      html += '<div class="card"><p>Die Registrierung ist gerade geschlossen. Bitte an den Admin wenden.</p></div>';
    }
    return html + loginCard(false);
  }

  function loginCard(collapsed) {
    if (S.api.kind === 'local') return '';
    const form = `<form id="loginform">
        <input type="password" id="login-code" placeholder="Admin- oder Bar-Code" autocomplete="current-password">
        <p class="small" id="login-err" style="color:var(--accent)"></p>
        <button class="btn block">Anmelden</button></form>`;
    return collapsed
      ? `<details class="card"><summary class="small">Mit Admin-/Bar-Code anmelden</summary><div style="margin-top:10px">${form}</div></details>`
      : `<div class="card"><h3 style="margin-top:0">🔑 Admin / Bar</h3>${form}</div>`;
  }

  // Auswahl "Wer bist du?" passend zur gewählten Mannschaft füllen.
  function fillRegPlayers() {
    const teamSel = $('#reg-team');
    const sel = $('#reg-player');
    if (!teamSel || !sel) return;
    const free = S.data.players.filter((p) => !p.registered && (p.teamId || '') === teamSel.value);
    sel.innerHTML = free.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
      '<option value="">➕ Ich stehe nicht in der Liste</option>';
    if (S.reg.player !== null && [...sel.options].some((o) => o.value === S.reg.player)) sel.value = S.reg.player;
    $('#reg-name-field').hidden = sel.value !== '';
  }

  function viewAdmin() {
    const st = S.data.settings;
    const c = connection();
    const teamOptions = (sel) => S.data.teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('') +
      `<option value="" ${!team(sel) ? 'selected' : ''}>– ohne –</option>`;
    let html = localBanner() + '<h2>⚙️ Setup</h2>';

    html += `<div class="card"><h3 style="margin-top:0">Turnier</h3>
      <label class="field"><span>Titel</span><input type="text" id="set-title" value="${esc(st.title)}"></label>
      <div class="row">
        <label class="field grow"><span>Kehren pro Spiel</span><input type="number" id="set-kehren" min="1" max="12" value="${st.kehren}"></label>
        <label class="field grow"><span>Schützen pro Kehre</span><input type="number" id="set-stocks" min="1" max="8" value="${st.stocks}"></label>
      </div>
      <p class="small muted">Jeder Schütze hat einen Stock. Gilt für alle Mannschaften gleich – bei größeren Teams wird durchgewechselt.</p>
      <h3>Teilnehmer &amp; Selbst-Eintragen</h3>
      <label class="check"><input type="checkbox" id="set-reg" ${st.registrationOpen ? 'checked' : ''}> Registrierung offen</label>
      <label class="check"><input type="checkbox" id="set-self" ${st.selfEntry ? 'checked' : ''}> Teilnehmer dürfen eigene Liter eintragen</label>
      <div class="row">
        <label class="field grow"><span>Mindestabstand (Min.)</span><input type="number" id="set-gap" min="0" max="120" value="${st.userMinGap}"></label>
        <label class="field grow"><span>Max. Liter / Stunde</span><input type="number" id="set-hour" min="0.1" max="5" step="0.1" value="${st.userMaxPerHour}"></label>
        <label class="field grow"><span>Max. Liter / Eintrag</span><input type="number" id="set-entry" min="0.1" max="5" step="0.1" value="${st.userMaxEntry}"></label>
      </div>
      <p class="small muted">Gilt nur für Teilnehmer. Bar und Admin haben keine Limits. Auch Einträge der Bar zählen für den Mindestabstand.</p>
      <button class="btn primary" data-act="settings-save">Speichern</button></div>`;

    html += `<h3>Mannschaften (${S.data.teams.length})</h3><div class="card">
      ${S.data.teams.map((t) => `<div class="member" data-team="${t.id}">
        <span style="align-self:center">${swatch(t.id)}</span>
        <input type="text" value="${esc(t.name)}" data-act-change="team-rename">
        <button class="iconbtn" data-act="team-del" data-id="${t.id}" title="Löschen">✕</button></div>`).join('')}
      <form id="newteam" class="member"><input type="text" id="newteam-name" placeholder="Neue Mannschaft">
        <button class="btn primary">+</button></form></div>`;

    const groups = S.data.teams.map((t) => ({ id: t.id, name: t.name }));
    groups.push({ id: null, name: 'Ohne Mannschaft' });
    html += `<h3>Personen (${S.data.players.length})</h3><div class="card">
      <p class="small muted">🔑 = hat sich registriert. Personen können sich auch selbst registrieren und ihren Namen aus der Liste wählen.</p>`;
    for (const grp of groups) {
      const members = S.data.players.filter((p) => (grp.id ? p.teamId === grp.id : !team(p.teamId)));
      if (!members.length) continue;
      html += `<div class="small muted" style="margin:12px 0 6px">${swatch(grp.id)}${esc(grp.name)}</div>`;
      for (const p of members) {
        html += `<div class="prow" data-player="${esc(p.id)}">
          <input type="text" value="${esc(p.name)}" data-act-change="player-save">
          <select data-act-change="player-save">${teamOptions(p.teamId)}</select>
          <span class="reg" title="${p.registered ? 'registriert' : 'nicht registriert'}">${p.registered ? '🔑' : '·'}</span>
          ${p.registered ? `<button class="iconbtn" data-act="player-reset" data-id="${esc(p.id)}" title="Login zurücksetzen">↺</button>` : ''}
          <button class="iconbtn" data-act="player-del" data-id="${esc(p.id)}" title="Löschen">✕</button></div>`;
      }
    }
    html += `<form id="newplayer" class="prow" style="margin-top:12px">
        <input type="text" id="newplayer-name" placeholder="Neue Person">
        <select id="newplayer-team">${teamOptions(S.data.teams[0] && S.data.teams[0].id)}</select>
        <button class="btn primary">+</button></form></div>`;

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
      <p class="small muted">Die Codes für Admin, Bar und Teilnehmer werden in <code>supabase/setup.sql</code> festgelegt.</p>
      ${S.api.kind === 'local' ? '' : '<button class="btn sm" data-act="logout">Abmelden</button>'}
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

  // ------------------------------------------------------------ Regeln

  function viewRules() {
    const st = S.data.settings;
    return `<div class="rules"><h2>So wird gewertet</h2>
      <div class="card">
        <h4>🥌 Ein Spiel</h4>
        <p>Zwei Mannschaften spielen gegeneinander, ein Spiel hat <b>${st.kehren} Kehren</b> (Durchgänge).
          Pro Kehre schießen von jeder Mannschaft <b>${st.stocks} Spieler</b> je einen Stock Richtung Daube (Zielwürfel).
          Hat ein Team mehr Leute, wird durchgewechselt.</p>
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
        <p>Jeder registrierte Teilnehmer trägt seine Getränke selbst ein – mit Regeln, damit es fair bleibt:</p>
        <ul><li>höchstens <b>${fmtNum(st.userMaxEntry)} l</b> pro Eintrag</li>
          <li>mindestens <b>${st.userMinGap} Minuten</b> zwischen zwei Einträgen (auch Einträge der Bar zählen)</li>
          <li>maximal <b>${fmtNum(st.userMaxPerHour)} l pro Stunde</b></li>
          <li>Rückgängig nur für eigene Einträge der letzten ${UNDO_MINUTES} Minuten</li></ul>
        <p>Die <b>Bar</b> kann für alle eintragen und korrigieren. Bei jedem Eintrag steht, wer ihn gemacht hat.</p>
        <p>Mannschaften werden nach <b>Gesamtlitern</b> gereiht (Ø pro Kopf steht daneben), dazu gibt es eine Einzelwertung.</p>
        <h4>⭐ Gesamtwertung</h4>
        <p>Platz in der Sportwertung + Platz in der Literwertung. <b>Die kleinste Summe gewinnt</b>,
          bei Gleichstand entscheidet der Sportplatz.</p>
        <p class="small muted">Bitte verantwortungsvoll trinken – und nach dem Eisstockschießen nicht mehr selbst fahren. 🚕</p>
      </div></div>`;
  }

  // ------------------------------------------------------------ Aktionen

  const num = (sel, def, min, max) => Math.min(max, Math.max(min, Number(String($(sel).value).replace(',', '.')) || def));

  const actions = {
    'ranktab': (el) => { S.rankTab = el.dataset.k; lsSet(LS.rank, S.rankTab); render(); },
    'toast-undo': () => { const u = toast.undo; $('#toast').hidden = true; if (u) u(); },

    'kehre': (el) => updateGame(el.dataset.g, (g) => {
      const k = g.kehren[+el.dataset.i];
      const t = el.dataset.team;
      if (k.team === t) { k.team = null; k.stocks = 0; } // nochmal tippen = zurücksetzen
      else { k.team = t; k.stocks = t === 'x' ? 0 : (k.stocks || 1); }
    }),
    'stocks': (el) => updateGame(el.dataset.g, (g) => { g.kehren[+el.dataset.i].stocks = +el.dataset.n; }),
    'kehre-add': (el) => updateGame(el.dataset.g, (g) => { g.kehren.push({ team: null, stocks: 0 }); }),
    'kehre-remove': (el) => updateGame(el.dataset.g, (g) => { g.kehren.pop(); }),
    'done': async (el) => {
      const g = S.data.games.find((x) => x.id === el.dataset.g);
      const done = el.dataset.v === '1';
      if (done && !g.kehren.some((k) => k && k.team) && !confirm('Es wurde noch keine Kehre eingetragen. Trotzdem beenden?')) return;
      if (await write((secret) => S.api.saveGame(secret, { ...g, done })) && done) {
        toast('Spiel gewertet ✓');
        location.hash = '#spiele';
      }
    },

    'drink': (el) => addDrink(el.dataset.p, Number(el.dataset.l)),
    'drink-del': (el) => write((secret) => S.api.deleteDrink(secret, el.dataset.id)),

    'logout': () => { setAuth(null); toast('Abgemeldet'); render(); },
    'logout-user': () => {
      if (!confirm('Wirklich abmelden? Danach kannst du nur wieder eintragen, wenn der Admin deinen Login zurücksetzt.')) return;
      setAuth(null);
      render();
    },

    'settings-save': () => {
      const s = {
        title: $('#set-title').value.trim() || B.DEFAULT_SETTINGS.title,
        kehren: Math.round(num('#set-kehren', 6, 1, 12)),
        stocks: Math.round(num('#set-stocks', 4, 1, 8)),
        registrationOpen: $('#set-reg').checked,
        selfEntry: $('#set-self').checked,
        userMinGap: Math.round(num('#set-gap', 10, 0, 120)),
        userMaxPerHour: Math.round(num('#set-hour', 1.5, 0.1, 5) * 100) / 100,
        userMaxEntry: Math.round(num('#set-entry', 1, 0.1, 5) * 100) / 100,
      };
      document.activeElement.blur();
      write((secret) => S.api.saveSettings(secret, s)).then((ok) => ok && toast('Gespeichert ✓'));
    },
    'team-del': (el) => {
      if (!confirm('Mannschaft inkl. ihrer Spiele löschen? Die Personen und ihre Liter bleiben erhalten (ohne Mannschaft).')) return;
      write((secret) => S.api.deleteTeam(secret, el.dataset.id));
    },
    'player-reset': (el) => {
      if (!confirm('Login zurücksetzen? Die Person kann sich danach neu registrieren (z. B. auf einem neuen Handy). Ihre Liter bleiben.')) return;
      write((secret) => S.api.resetPlayerLogin(secret, el.dataset.id)).then((ok) => ok && toast('Login zurückgesetzt ✓'));
    },
    'player-del': (el) => {
      if (!confirm('Person inkl. aller ihrer Liter löschen?')) return;
      write((secret) => S.api.deletePlayer(secret, el.dataset.id));
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
      write((secret) => S.api.setSchedule(secret, schedule.roundRobin(ids))).then((ok) => {
        if (ok) { toast('Spielplan erstellt ✓'); location.hash = '#spiele'; }
      });
    },
    'game-add': () => {
      const a = $('#ng-a').value;
      const b = $('#ng-b').value;
      if (a === b) { toast('Zwei verschiedene Mannschaften wählen', { error: true }); return; }
      const g = { teamA: a, teamB: b, round: parseInt($('#ng-round').value, 10) || 1, bahn: parseInt($('#ng-bahn').value, 10) || 1 };
      document.activeElement.blur();
      write((secret) => S.api.addGame(secret, g)).then((ok) => ok && toast('Spiel hinzugefügt ✓'));
    },
    'game-del': (el) => confirm('Spiel löschen?') && write((secret) => S.api.deleteGame(secret, el.dataset.id)),
    'export': () => {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...S.data, rankings: scoring.rankings(S.data) }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'eisstock-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    'reset-results': () => confirm('Alle Spiele und Liter löschen? Mannschaften und Personen bleiben erhalten.') &&
      write((secret) => S.api.reset(secret, 'results')),
    'reset-all': () => confirm('Wirklich ALLES löschen (Mannschaften, Personen inkl. Logins, Spiele, Liter)?') &&
      write((secret) => S.api.reset(secret, 'all')),
    'conn-save': () => {
      const url = $('#conn-url').value.trim();
      const key = $('#conn-key').value.trim();
      if (!/^https?:\/\//.test(url) || !key) { toast('URL (https://…) und Key angeben', { error: true }); return; }
      lsSet(LS.conn, JSON.stringify({ url, key }));
      location.reload();
    },
    'conn-clear': () => { lsSet(LS.conn, null); location.reload(); },
  };

  // Änderungen an Eingabefeldern (Speichern beim Verlassen des Feldes)
  const changeActions = {
    'team-rename': (el) => {
      const name = el.value.trim();
      if (!name) { render(); return; }
      write((secret) => S.api.saveTeam(secret, { id: el.closest('[data-team]').dataset.team, name }));
    },
    'player-save': (el) => {
      const row = el.closest('[data-player]');
      const name = row.querySelector('input').value.trim();
      if (!name) { render(); return; }
      write((secret) => S.api.savePlayer(secret, { id: row.dataset.player, name, teamId: row.querySelector('select').value || null }));
    },
  };

  const forms = {
    regform: async () => {
      saveRegDraft();
      const showErr = (msg) => { S.reg.err = msg; $('#reg-err').textContent = msg; };
      const code = S.reg.code.trim();
      const playerId = S.reg.player || null;
      const name = S.reg.name.trim();
      if (!code) { showErr('Bitte den Teilnehmer-Code eingeben.'); return; }
      if (!playerId && name.length < 2) { showErr('Bitte deinen Namen eingeben.'); return; }
      showErr('');
      try {
        const r = await S.api.register(code, name, S.reg.team || null, playerId);
        setAuth({ secret: r.secret, role: r.role, playerId: r.playerId });
        S.reg = { code: '', team: null, player: null, name: '', err: '' };
        document.activeElement.blur();
        toast('Willkommen! Du kannst jetzt deine Liter eintragen 🍺');
        location.hash = '#liter';
        await refresh(true);
      } catch (e) {
        showErr(e.message);
      }
    },
    loginform: async () => {
      const code = $('#login-code').value.trim();
      if (!code) return;
      try {
        const r = await S.api.login(code);
        if (r.role === 'user') throw new Error('Das ist kein Admin- oder Bar-Code.');
        setAuth({ secret: code, role: r.role, playerId: null });
        document.activeElement.blur();
        toast(r.role === 'admin' ? 'Als Admin angemeldet 🔓' : 'Als Bar angemeldet 🍺');
        render();
      } catch (e) {
        $('#login-err').textContent = /Ungültig/.test(e.message) ? 'Falscher Code.' : e.message;
      }
    },
    newteam: () => {
      const name = $('#newteam-name').value.trim();
      if (!name) return;
      document.activeElement.blur();
      write((secret) => S.api.saveTeam(secret, { id: null, name })).then((ok) => ok && toast('Mannschaft angelegt ✓'));
    },
    newplayer: () => {
      const name = $('#newplayer-name').value.trim();
      if (!name) return;
      const teamId = $('#newplayer-team').value || null;
      document.activeElement.blur();
      write((secret) => S.api.savePlayer(secret, { id: null, name, teamId })).then((ok) => {
        if (!ok) return;
        const input = $('#newplayer-name');
        const sel = $('#newplayer-team');
        if (sel) sel.value = teamId || '';
        if (input) input.focus(); // gleich die nächste Person eintippen
      });
    },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    ev.preventDefault();
    fn(el);
  });

  document.addEventListener('submit', (ev) => {
    const fn = forms[ev.target.id];
    if (!fn) return;
    ev.preventDefault();
    fn();
  });

  function saveRegDraft() {
    if (!$('#regform')) return;
    S.reg.code = $('#reg-code').value;
    S.reg.team = $('#reg-team').value;
    S.reg.player = $('#reg-player').value;
    S.reg.name = $('#reg-name').value;
  }

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'reg-team') { S.reg.player = null; fillRegPlayers(); saveRegDraft(); return; }
    if (t.id === 'reg-player') { $('#reg-name-field').hidden = t.value !== ''; saveRegDraft(); return; }
    const fn = t.dataset && changeActions[t.dataset.actChange];
    if (fn) fn(t);
  });

  document.addEventListener('input', (ev) => {
    if (/^reg-/.test(ev.target.id)) saveRegDraft();
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
  refresh(true).then(verifyAuth);
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  // Wartezeit-Anzeige für Teilnehmer aktuell halten
  setInterval(() => { if (!document.hidden && myId() && route().view === 'liter') render(); }, 20000);
})();
