// Live races: create or join a room, start together, and watch everyone's progress.
// Talks to server.js. When the page is not served by it (GitHub Pages, file://),
// the race panel stays hidden and the game is single-player.
(() => {
  'use strict';

  const game = window.puzzleGame;
  if (!game) return;

  const SESSION_KEY = 'twenty-piece-rush:race';
  const NAME_KEY = 'twenty-piece-rush:name';

  const $ = (id) => document.getElementById(id);
  const els = {
    section: $('race'),
    note: $('raceNote'),
    entry: $('raceEntry'),
    name: $('raceName'),
    createBtn: $('raceCreateBtn'),
    code: $('raceCode'),
    joinBtn: $('raceJoinBtn'),
    room: $('raceRoom'),
    codeValue: $('raceCodeValue'),
    copyBtn: $('raceCopyBtn'),
    startBtn: $('raceStartBtn'),
    leaveBtn: $('raceLeaveBtn'),
    status: $('raceStatus'),
    standings: $('standings'),
    countdown: $('raceCountdown'),
    countdownValue: $('raceCountdownValue'),
  };

  let session = null; // { code, playerId, secret }
  let room = null; // latest room state from the server
  let source = null; // EventSource for live updates
  let clockOffset = 0; // server clock minus this device's clock
  let startedRaceId = null; // the race this page started a round for
  let countdownTimer = 0;
  let pending = null; // latest progress not yet confirmed by the server
  let sending = false;
  let unloading = false; // the page is going away; its closed connection is not a real error

  // ---------------------------------------------------------------- helpers

  const pad = (value) => String(value).padStart(2, '0');
  const formatMs = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };
  const pictureName = (id) => game.pictures.find((p) => p.id === id)?.name || 'the picture';
  const levelName = (id) => game.levels[id]?.name || 'Medium';
  const raceLabel = (pictureId, level) => `${pictureName(pictureId)} on ${levelName(level)}`;
  const creds = () => ({ playerId: session.playerId, secret: session.secret });

  function store(kind, key, value) {
    try {
      const area = kind === 'session' ? window.sessionStorage : window.localStorage;
      if (value === null) area.removeItem(key);
      else area.setItem(key, value);
    } catch {
      // Storage can be blocked; the race still works for this page load.
    }
  }

  function recall(kind, key) {
    try {
      return (kind === 'session' ? window.sessionStorage : window.localStorage).getItem(key);
    } catch {
      return null;
    }
  }

  function setNote(text, error = false) {
    els.note.textContent = text;
    els.note.classList.toggle('is-error', error);
  }

  async function api(path, body) {
    let res;
    try {
      res = await fetch(`api/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw new Error('Could not reach the race server. Check that it is still running.');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      // Fall through to the generic message.
    }
    if (!res.ok) throw new Error(data.error || 'The race server could not do that. Try again.');
    return data;
  }

  async function serverAvailable() {
    try {
      const res = await fetch('api/health', { cache: 'no-store' });
      const data = await res.json();
      return res.ok && data.ok === true;
    } catch {
      return false;
    }
  }

  function setRoomInUrl(code) {
    try {
      const url = new URL(window.location.href);
      if (code) url.searchParams.set('room', code);
      else url.searchParams.delete('room');
      window.history.replaceState(null, '', url);
    } catch {
      // Some frames refuse history changes; the code is still shown on screen.
    }
  }

  // ---------------------------------------------------------- joining

  function readName() {
    const name = els.name.value.trim();
    if (!name) {
      setNote('Enter your name first, so others know who you are.', true);
      els.name.focus();
      return null;
    }
    store('local', NAME_KEY, name);
    return name;
  }

  async function createRace() {
    const name = readName();
    if (!name) return;
    els.createBtn.disabled = true;
    try {
      enterRoom(await api('rooms', { name, ...game.currentSetup() }));
    } catch (err) {
      setNote(err.message, true);
    } finally {
      els.createBtn.disabled = false;
    }
  }

  async function joinRace() {
    const name = readName();
    if (!name) return;
    const code = els.code.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      setNote('A race code is 4 letters, like ABCD.', true);
      els.code.focus();
      return;
    }
    els.joinBtn.disabled = true;
    try {
      enterRoom(await api(`rooms/${code}/join`, { name }));
    } catch (err) {
      setNote(err.message, true);
    } finally {
      els.joinBtn.disabled = false;
    }
  }

  function enterRoom({ code, playerId, secret }) {
    session = { code, playerId, secret };
    store('session', SESSION_KEY, JSON.stringify(session));
    setRoomInUrl(code);
    setNote('');
    els.entry.hidden = true;
    els.room.hidden = false;
    els.codeValue.textContent = code;
    els.status.textContent = 'Connecting…';
    connect();
  }

  function connect() {
    if (source) source.close();
    const query = new URLSearchParams({ player: session.playerId, secret: session.secret });
    source = new EventSource(`api/rooms/${session.code}/events?${query}`);
    source.addEventListener('state', (event) => onState(JSON.parse(event.data)));
    source.addEventListener('open', () => setNote(''));
    source.addEventListener('error', () => {
      if (unloading) return;
      // CLOSED means the server turned us away (race gone or not a member).
      if (source && source.readyState === EventSource.CLOSED) {
        leaveLocally('That race is no longer running. Create a new one or join with another code.');
      } else if (session) {
        setNote('Lost the connection to the race server. Reconnecting…', true);
      }
    });
  }

  function leaveLocally(message = '') {
    if (source) source.close();
    source = null;
    clearCountdown();
    game.stopRace({ abandon: true });
    game.setRoomRole(null);
    game.setRank(null);
    session = null;
    room = null;
    startedRaceId = null;
    pending = null;
    store('session', SESSION_KEY, null);
    setRoomInUrl(null);
    els.room.hidden = true;
    els.entry.hidden = false;
    setNote(message || 'Create a race and share the code, or join one with a code.');
  }

  async function leaveRace() {
    const current = session;
    leaveLocally('You left the race.');
    try {
      await api(`rooms/${current.code}/leave`, { playerId: current.playerId, secret: current.secret });
    } catch {
      // The server drops players who stay away, so a failed leave is harmless.
    }
  }

  // ------------------------------------------------------------- live state

  function onState(state) {
    if (!session || state.code !== session.code) return;
    clockOffset = state.now - Date.now();
    room = state;
    const me = state.players.find((p) => p.id === session.playerId);
    if (!me) {
      leaveLocally('You were taken out of the race after being away. Join again with the code.');
      return;
    }
    const isHost = state.hostId === session.playerId;
    game.setRoomRole(isHost ? 'host' : 'guest');
    if (!isHost && state.status !== 'racing') game.showSetup({ pictureId: state.pictureId, level: state.level });
    followRace(state);
    renderRoom();
  }

  function followRace(state) {
    const race = state.race;
    const inRace = Boolean(race && race.participants.includes(session.playerId));
    if (state.status === 'racing' && inRace && startedRaceId !== race.id) {
      startedRaceId = race.id;
      pending = null;
      scheduleStart(race);
    }
    if (state.status === 'finished' && race && race.id === startedRaceId) {
      clearCountdown();
      game.stopRace();
    }
  }

  // Count down to the shared start time, then start the round with the shared shuffle.
  function scheduleStart(race) {
    clearCountdown();
    const localStart = race.startAt - clockOffset;
    const localEnd = race.endsAt - clockOffset;
    if (Date.now() >= localEnd) return;
    game.showSetup({ pictureId: race.pictureId, level: race.level });
    game.revealBoard();
    const step = () => {
      const left = localStart - Date.now();
      if (left <= 0) {
        clearCountdown();
        game.startRace({
          id: race.id,
          pictureId: race.pictureId,
          level: race.level,
          order: race.order,
          endsAt: localEnd,
        });
        renderRoom();
        return;
      }
      els.countdown.hidden = false;
      els.countdownValue.textContent = String(Math.ceil(left / 1000));
      countdownTimer = window.setTimeout(step, Math.min(250, left));
    };
    step();
  }

  function clearCountdown() {
    window.clearTimeout(countdownTimer);
    countdownTimer = 0;
    els.countdown.hidden = true;
  }

  // Send the newest counts; on a failed send, try again shortly so a finish is never lost.
  function reportProgress({ placed, misses }) {
    if (!session || !room || room.status !== 'racing' || room.race?.id !== startedRaceId) return;
    pending = { placed, misses, raceId: startedRaceId };
    flushProgress();
  }

  async function flushProgress() {
    if (sending || !pending || !session) return;
    if (!room || room.status !== 'racing' || room.race?.id !== pending.raceId) {
      pending = null; // that race is over; nothing left to report
      return;
    }
    sending = true;
    const sent = pending;
    try {
      await api(`rooms/${session.code}/progress`, { ...creds(), ...sent });
      if (pending === sent) pending = null;
    } catch {
      window.setTimeout(flushProgress, 1500);
    } finally {
      sending = false;
    }
    if (pending && pending !== sent) flushProgress();
  }

  // ----------------------------------------------------------------- render

  function renderRoom() {
    if (!room || !session) return;
    const state = room;
    const isHost = state.hostId === session.playerId;
    const race = state.race;
    const racing = state.status === 'racing';
    const inRace = Boolean(race && race.participants.includes(session.playerId));

    els.entry.hidden = true;
    els.room.hidden = false;
    els.codeValue.textContent = state.code;
    els.startBtn.hidden = !isHost;
    const setup = game.currentSetup();
    els.startBtn.disabled = racing || !setup.pictureId;
    els.startBtn.textContent = state.status === 'finished' ? 'Start next race' : 'Start race';

    const host = state.players.find((p) => p.id === state.hostId);
    let status;
    if (racing && Date.now() + clockOffset < race.startAt) {
      status = `Get ready: ${raceLabel(race.pictureId, race.level)}.`;
    } else if (racing) {
      status = inRace
        ? `Race on: ${raceLabel(race.pictureId, race.level)}. First to place all ${race.total} pieces wins.`
        : 'A race is running. You will be in the next one.';
    } else if (state.status === 'finished') {
      const winner = race.standings.find((s) => s.timeMs !== null);
      const result = winner ? `${winner.name} won in ${formatMs(winner.timeMs)}.` : 'Nobody finished in time.';
      status = isHost
        ? `${result} Start the next race when everyone is ready.`
        : `${result} Waiting for ${host ? host.name : 'the host'} to start the next race.`;
    } else {
      const count = state.players.length;
      // The host sees their own pick at once; Start sends it if the server has not caught up.
      const next = isHost
        ? raceLabel(setup.pictureId || state.pictureId, setup.level)
        : raceLabel(state.pictureId, state.level);
      status = isHost
        ? `${count} ${count === 1 ? 'player' : 'players'} here. Next race: ${next}. Share the code, then start the race.`
        : `Waiting for ${host ? host.name : 'the host'} to start the race: ${next}.`;
    }
    if (isHost && !racing && !setup.pictureId) status += ' Pick a built-in picture below first.';
    els.status.textContent = status;

    renderStandings(state);
    if (racing && inRace) {
      const place = race.standings.findIndex((s) => s.id === session.playerId) + 1;
      game.setRank(place ? `${place}/${race.standings.length}` : null);
    } else {
      game.setRank(null);
    }
  }

  function tag(text) {
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = text;
    return el;
  }

  function nameCell(name, id, state) {
    const el = document.createElement('span');
    el.className = 'standing-name';
    el.append(document.createTextNode(name));
    if (id === session.playerId) el.append(tag('you'));
    if (id === state.hostId) el.append(tag('host'));
    return el;
  }

  function cell(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function renderStandings(state) {
    const rows = [];
    const race = state.race;
    const online = new Map(state.players.map((p) => [p.id, p.online]));
    if (race) {
      const total = race.total;
      race.standings.forEach((s, i) => {
        const li = document.createElement('li');
        li.className = 'standing';
        li.classList.toggle('is-you', s.id === session.playerId);
        li.classList.toggle('is-done', s.timeMs !== null);
        li.classList.toggle('is-away', s.left || online.get(s.id) === false);
        const bar = document.createElement('span');
        bar.className = 'standing-bar';
        const fill = document.createElement('span');
        fill.style.transform = `scaleX(${s.placed / total})`;
        bar.append(fill);
        let time = '';
        if (s.timeMs !== null) time = formatMs(s.timeMs);
        else if (s.left) time = 'Left';
        else if (online.get(s.id) === false) time = 'Away';
        else if (state.status === 'finished') time = 'Out of time';
        li.append(
          cell('standing-rank', String(i + 1)),
          nameCell(s.name, s.id, state),
          bar,
          cell('standing-stat', `${s.placed}/${total}`),
          cell('standing-time', time),
        );
        li.setAttribute(
          'aria-label',
          `${i + 1}. ${s.name}: ${s.placed} of ${total} pieces, ${s.misses} misses${time ? `, ${time}` : ''}`,
        );
        rows.push(li);
      });
    }
    // Players who are here but not in the current race (or everyone, before the first race).
    const racers = new Set(race ? race.participants : []);
    for (const p of state.players) {
      if (racers.has(p.id)) continue;
      const li = document.createElement('li');
      li.className = 'standing is-lobby';
      li.classList.toggle('is-you', p.id === session.playerId);
      li.classList.toggle('is-away', !p.online);
      li.append(nameCell(p.name, p.id, state), cell('standing-time', p.online ? (race ? 'Next race' : 'Ready') : 'Away'));
      rows.push(li);
    }
    els.standings.replaceChildren(...rows);
  }

  // ------------------------------------------------------------------- copy

  async function copyInvite() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', session.code);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      els.copyBtn.textContent = 'Link copied';
      window.setTimeout(() => {
        els.copyBtn.textContent = 'Copy invite link';
      }, 2000);
    } catch {
      setNote(`Copy this link and send it to your friends: ${link}`);
    }
  }

  // ------------------------------------------------------------------- boot

  function bind() {
    els.entry.addEventListener('submit', (event) => {
      event.preventDefault();
      if (els.code.value.trim()) joinRace();
      else createRace();
    });
    els.createBtn.addEventListener('click', createRace);
    els.code.addEventListener('input', () => {
      els.code.value = els.code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
    els.startBtn.addEventListener('click', async () => {
      els.startBtn.disabled = true;
      try {
        const setup = game.currentSetup();
        if (setup.pictureId && (setup.pictureId !== room.pictureId || setup.level !== room.level)) {
          await api(`rooms/${session.code}/setup`, { ...creds(), ...setup });
        }
        await api(`rooms/${session.code}/start`, creds());
      } catch (err) {
        setNote(err.message, true);
      } finally {
        renderRoom();
      }
    });
    els.leaveBtn.addEventListener('click', leaveRace);
    els.copyBtn.addEventListener('click', copyInvite);
    // A refresh keeps you in the race: close the connection quietly so it is not
    // mistaken for the server turning you away.
    window.addEventListener('pagehide', () => {
      unloading = true;
      if (source) source.close();
    });
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      unloading = false; // restored from the back/forward cache
      if (session) connect();
    });

    game.on('progress', reportProgress);
    game.on('end', reportProgress);
    // The host's picture and difficulty become the next race's.
    game.on('setup', (setup) => {
      if (!session || !room || room.hostId !== session.playerId) return;
      const changed = setup.pictureId !== room.pictureId || setup.level !== room.level;
      if (setup.pictureId && room.status !== 'racing' && changed) {
        api(`rooms/${session.code}/setup`, { ...creds(), ...setup }).catch((err) => setNote(err.message, true));
      }
      renderRoom();
    });
  }

  async function boot() {
    if (!(await serverAvailable())) return;
    bind();
    els.section.hidden = false;
    els.entry.hidden = false;
    els.name.value = recall('local', NAME_KEY) || '';
    const urlCode = new URL(window.location.href).searchParams.get('room');
    let saved = null;
    try {
      saved = JSON.parse(recall('session', SESSION_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (saved && saved.code && (!urlCode || urlCode.toUpperCase() === saved.code)) {
      enterRoom(saved);
      return;
    }
    if (urlCode) {
      els.code.value = urlCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      setNote(`You're invited to race ${els.code.value}. Enter your name and press Join race.`);
      if (!els.name.value) els.name.focus();
      return;
    }
    setNote('Create a race and share the code, or join one with a code.');
  }

  boot();
})();
