(() => {
  'use strict';

  // More pieces get more time in total, but less time per piece.
  // server.js has the same table for races; keep the two in step.
  const LEVELS = {
    easy: { name: 'Easy', cols: 4, rows: 3, seconds: 240 },
    medium: { name: 'Medium', cols: 5, rows: 4, seconds: 300 },
    hard: { name: 'Hard', cols: 6, rows: 5, seconds: 360 },
  };
  const DEFAULT_LEVEL = 'medium';
  const SOURCE_W = 1200; // every picture is cropped to 5:4 at this size
  const SOURCE_H = 960;
  const DRAG_THRESHOLD_PX = 6;
  const STORAGE_PREFIX = 'twenty-piece-rush:';

  const PICTURES = [
    { id: 'alpine-dusk', name: 'Alpine Dusk', src: 'assets/alpine-dusk.svg' },
    { id: 'harbor-morning', name: 'Harbor Morning', src: 'assets/harbor-morning.svg' },
    { id: 'city-lights', name: 'City Lights', src: 'assets/city-lights.svg' },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    hud: $('hud'),
    table: $('table'),
    board: $('board'),
    boardCover: $('boardCover'),
    coverArt: $('coverArt'),
    coverTitle: $('coverTitle'),
    levels: $('levels'),
    startBtn: $('startBtn'),
    lid: $('lid'),
    tray: $('tray'),
    howTo: $('howTo'),
    looseCount: $('looseCount'),
    refArt: $('refArt'),
    clock: $('clock'),
    clockDigits: $('clockDigits'),
    clockFill: $('clockFill'),
    placedCount: $('placedCount'),
    missCount: $('missCount'),
    bestTime: $('bestTime'),
    rankStat: $('rankStat'),
    rankValue: $('rankValue'),
    pauseBtn: $('pauseBtn'),
    pauseText: $('pauseText'),
    restartBtn: $('restartBtn'),
    pauseCover: $('pauseCover'),
    resumeBtn: $('resumeBtn'),
    pictureList: $('pictureList'),
    pictureNote: $('pictureNote'),
    uploadLabel: $('uploadLabel'),
    uploadInput: $('uploadInput'),
    announcer: $('announcer'),
    resultDialog: $('resultDialog'),
    resultKicker: $('resultKicker'),
    resultTitle: $('resultTitle'),
    resultText: $('resultText'),
    resultTime: $('resultTime'),
    resultPlaced: $('resultPlaced'),
    resultMisses: $('resultMisses'),
    againBtn: $('againBtn'),
  };

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => motionQuery.matches;

  // status: loading | idle | scrambling | playing | paused | won | lost
  const game = {
    status: 'loading',
    level: DEFAULT_LEVEL,
    cols: 0, // grid of the current level, set by applyLevel()
    rows: 0,
    total: 0,
    limitMs: 0,
    picture: null,
    art: null, // URL of the 5:4 picture every piece is cut from
    artIsBlob: false,
    slots: [],
    cells: [],
    pieces: [],
    placed: 0,
    misses: 0,
    remaining: 0,
    deadline: 0,
    timerId: 0,
    resultTimer: 0,
    warned: new Set(),
    selected: null,
    loadToken: 0,
    race: null, // { id, endsAt } while a live race round is on
    roomRole: null, // 'host' or 'guest' while in a race room
  };

  let drag = null;
  let note = { text: '', error: false };
  let customPicture = null;
  const customBests = new Map();
  const pictureButtons = new Map();
  const levelInputs = new Map();
  const raceHooks = { progress: [], end: [], setup: [] };
  const emitRace = (type, detail) => raceHooks[type].forEach((fn) => fn(detail));

  // ---------------------------------------------------------------- helpers

  const pad = (value) => String(value).padStart(2, '0');
  const formatSeconds = (seconds) => {
    const s = Math.max(0, seconds);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };
  const secondsLeft = (ms) => Math.ceil(ms / 1000);
  // Matches the clock: time used = limit minus the seconds the clock still shows.
  const formatUsed = (usedMs) => formatSeconds(Math.floor(usedMs / 1000));
  const plural = (count, one, many) => (count === 1 ? one : many);
  const formatLimit = (seconds) => `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;

  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(STORAGE_PREFIX + key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      // Storage can be blocked (private mode, sandboxed frames). The game works without it.
    }
  }

  // Best times are kept per picture and level. Medium keeps the key from before levels
  // existed, so earlier best times still count.
  const bestKey = (picture) =>
    game.level === DEFAULT_LEVEL ? `best:${picture.id}` : `best:${game.level}:${picture.id}`;

  function getBest(picture) {
    if (!picture) return null;
    if (picture.custom) return customBests.get(`${game.level}:${picture.src}`) ?? null;
    const value = Number(storageGet(bestKey(picture)));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function setBest(picture, ms) {
    if (picture.custom) customBests.set(`${game.level}:${picture.src}`, ms);
    else storageSet(bestKey(picture), String(Math.round(ms)));
  }

  function announce(message) {
    els.announcer.textContent = '';
    window.setTimeout(() => {
      els.announcer.textContent = message;
    }, 30);
  }

  // Restart a CSS animation class, and drop it once the animation ends.
  function flash(el, className) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    el.addEventListener('animationend', () => el.classList.remove(className), { once: true });
  }

  // ----------------------------------------------------------------- images

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  // Crop the picture to 5:4 (cover fit) and save it as an image file. Pieces are then
  // plain background images: browsers can wipe canvas contents when their graphics
  // reset (Firefox does), but they always redraw images.
  function cropToImageUrl(img) {
    const canvas = document.createElement('canvas');
    canvas.width = SOURCE_W;
    canvas.height = SOURCE_H;
    const ctx = canvas.getContext('2d');
    const iw = img.naturalWidth || SOURCE_W;
    const ih = img.naturalHeight || SOURCE_H;
    const scale = Math.max(SOURCE_W / iw, SOURCE_H / ih);
    const sw = SOURCE_W / scale;
    const sh = SOURCE_H / scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, SOURCE_W, SOURCE_H);
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
      } catch {
        // Pages opened from file:// cannot export their own images; use the original instead.
        resolve(null);
      }
    });
  }

  function paintArt(el) {
    el.style.backgroundImage = `url("${game.art}")`;
  }

  // Show one piece of the picture: the full image, scaled to the grid and shifted.
  function paintPiece(el, index) {
    const { cols, rows } = game;
    const col = index % cols;
    const row = Math.floor(index / cols);
    paintArt(el);
    el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
    el.style.backgroundPosition = `${(col / (cols - 1)) * 100}% ${(row / (rows - 1)) * 100}%`;
  }

  // ------------------------------------------------------------------ setup

  function applyLevel(id) {
    const level = LEVELS[id] || LEVELS[DEFAULT_LEVEL];
    game.level = LEVELS[id] ? id : DEFAULT_LEVEL;
    game.cols = level.cols;
    game.rows = level.rows;
    game.total = level.cols * level.rows;
    game.limitMs = level.seconds * 1000;
  }

  // (Re)build the board spots and box cells for the current level's grid.
  function buildBoard() {
    els.board.replaceChildren();
    els.tray.replaceChildren();
    game.slots = [];
    game.cells = [];
    els.board.style.setProperty('--cols', game.cols);
    els.board.style.setProperty('--rows', game.rows);
    els.table.dataset.level = game.level;
    els.table.style.setProperty('--piece-aspect', (SOURCE_W / game.cols / (SOURCE_H / game.rows)).toFixed(4));
    for (let i = 0; i < game.total; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = String(i);
      slot.tabIndex = -1;
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label', `Board spot, row ${Math.floor(i / game.cols) + 1}, column ${(i % game.cols) + 1}`);
      slot.addEventListener('click', () => onSlotActivate(slot));
      slot.addEventListener('keydown', (event) => onSlotKeydown(event, i));
      els.board.append(slot);
      game.slots.push(slot);
    }
    for (let i = 0; i < game.total; i++) {
      const cell = document.createElement('div');
      cell.className = 'tray-cell';
      els.tray.append(cell);
      game.cells.push(cell);
    }
  }

  function buildLevelPicker() {
    for (const [id, level] of Object.entries(LEVELS)) {
      const label = document.createElement('label');
      label.className = 'level';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'level';
      input.value = id;
      input.id = `level-${id}`;
      input.addEventListener('change', () => {
        if (input.checked) selectLevel(id);
      });
      const face = document.createElement('span');
      face.className = 'level-face';
      const name = document.createElement('span');
      name.className = 'level-name';
      name.textContent = level.name;
      const detail = document.createElement('span');
      detail.className = 'level-detail';
      detail.textContent = `${level.cols * level.rows} pieces · ${formatLimit(level.seconds)}`;
      face.append(name, detail);
      label.append(input, face);
      els.levels.append(label);
      levelInputs.set(id, input);
    }
  }

  function markActiveLevel() {
    levelInputs.forEach((input, id) => {
      input.checked = id === game.level;
    });
  }

  function selectLevel(id, { force = false } = {}) {
    if (!LEVELS[id]) return false;
    if (!force && !canChangeSetup()) {
      markActiveLevel();
      return false;
    }
    if (id !== game.level) {
      stopRound();
      applyLevel(id);
      buildBoard();
      storageSet('level', id);
      resetToIdle();
      emitSetup();
    }
    markActiveLevel();
    return true;
  }

  function addPictureButton(picture) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picture';
    button.setAttribute('aria-pressed', 'false');
    const img = document.createElement('img');
    img.className = 'picture-thumb';
    img.alt = '';
    img.width = 300;
    img.height = 240;
    img.src = picture.src;
    const name = document.createElement('span');
    name.className = 'picture-name';
    name.textContent = picture.name;
    button.append(img, name);
    els.pictureList.insertBefore(button, els.uploadLabel);
    return button;
  }

  function buildPictureList() {
    for (const picture of PICTURES) {
      const button = addPictureButton(picture);
      button.addEventListener('click', () => selectPicture(picture));
      pictureButtons.set(picture.id, button);
    }
  }

  function markActivePicture() {
    pictureButtons.forEach((button, id) => {
      button.setAttribute('aria-pressed', String(game.picture?.id === id));
    });
  }

  // --------------------------------------------------------------- pictures

  const canChangeSetup = () =>
    game.status !== 'playing' && game.status !== 'scrambling' && game.roomRole !== 'guest';

  const currentSetup = () => ({
    pictureId: game.picture && !game.picture.custom ? game.picture.id : null,
    level: game.level,
  });
  const emitSetup = () => emitRace('setup', currentSetup());

  async function selectPicture(picture, { force = false } = {}) {
    if (!force && !canChangeSetup()) return false;
    const token = ++game.loadToken;
    setNote(`Loading ${picture.name}…`);
    els.startBtn.disabled = true;
    let cropped = null;
    try {
      const img = await loadImage(picture.src);
      if (token !== game.loadToken) return false;
      cropped = await cropToImageUrl(img);
      if (cropped) await loadImage(cropped);
      if (token !== game.loadToken) {
        if (cropped) URL.revokeObjectURL(cropped);
        return false;
      }
      const previous = game.artIsBlob ? game.art : null;
      game.picture = picture;
      game.art = cropped || picture.src;
      game.artIsBlob = Boolean(cropped);
      paintArt(els.coverArt);
      paintArt(els.refArt);
      if (!picture.custom) storageSet('picture', picture.id);
      markActivePicture();
      setNote('');
      resetToIdle();
      if (previous) URL.revokeObjectURL(previous);
      emitSetup();
      return true;
    } catch {
      if (cropped) URL.revokeObjectURL(cropped);
      if (token !== game.loadToken) return false;
      setNote(`${picture.name} could not be loaded. Try another picture or a JPG or PNG photo.`, true);
      els.startBtn.disabled = !game.art;
      return false;
    }
  }

  function prettyFileName(fileName) {
    const base = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
    if (!base) return 'Your photo';
    return base.length > 32 ? `${base.slice(0, 31)}…` : base;
  }

  async function onUpload() {
    const file = els.uploadInput.files && els.uploadInput.files[0];
    els.uploadInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNote('That file is not an image. Choose a JPG, PNG, WebP or GIF.', true);
      return;
    }
    const picture = { id: 'custom', name: prettyFileName(file.name), src: URL.createObjectURL(file), custom: true };
    const ok = await selectPicture(picture);
    if (!ok) {
      URL.revokeObjectURL(picture.src);
      return;
    }
    if (customPicture) {
      customBests.delete(customPicture.src);
      URL.revokeObjectURL(customPicture.src);
    }
    customPicture = picture;
    let button = pictureButtons.get('custom');
    if (!button) {
      button = addPictureButton(picture);
      button.addEventListener('click', () => customPicture && selectPicture(customPicture));
      pictureButtons.set('custom', button);
    } else {
      button.querySelector('img').src = picture.src;
      button.querySelector('.picture-name').textContent = picture.name;
    }
    markActivePicture();
  }

  function setNote(text, error = false) {
    note = { text, error };
    renderNote();
  }

  function renderNote() {
    let text = note.text;
    let error = note.error;
    if (game.roomRole === 'guest') {
      text = 'The race host picks the picture and difficulty.';
      error = false;
    } else if (game.race && !canChangeSetup()) {
      text = 'Finish the race to switch pictures or difficulty.';
      error = false;
    } else if (!canChangeSetup()) {
      text = 'Pause or finish this round to switch pictures or difficulty.';
      error = false;
    } else if (game.roomRole === 'host' && !text) {
      text = game.picture?.custom
        ? 'Races use the built-in pictures. Pick one to start a race.'
        : 'Your picture and difficulty are used for the next race.';
    } else if (game.status === 'paused' && !text) {
      text = 'Switching pictures or difficulty now ends this round.';
    }
    els.pictureNote.textContent = text;
    els.pictureNote.classList.toggle('is-error', error);
  }

  // ------------------------------------------------------------------ rounds

  function clearBoard() {
    for (const slot of game.slots) {
      slot.replaceChildren();
      slot.classList.remove('is-filled', 'is-target', 'is-wrong');
      slot.removeAttribute('aria-disabled');
    }
    for (const cell of game.cells) cell.replaceChildren();
    els.board.classList.remove('is-complete', 'has-selection');
    els.lid.classList.remove('is-over');
  }

  function stopRound() {
    stopTimer();
    cancelDrag();
    clearSelection();
    window.clearTimeout(game.resultTimer);
    game.resultTimer = 0;
    if (els.resultDialog.open) els.resultDialog.close();
  }

  function resetCounters() {
    game.placed = 0;
    game.misses = 0;
    game.remaining = game.limitMs;
    game.warned.clear();
  }

  function resetToIdle() {
    stopRound();
    clearBoard();
    resetCounters();
    game.pieces = [];
    game.status = 'idle';
    els.coverTitle.textContent = game.picture ? game.picture.name : 'Loading picture…';
    els.boardCover.hidden = false;
    els.startBtn.disabled = !game.art;
    els.tray.hidden = true;
    els.howTo.hidden = false;
    showPause(false);
    render();
  }

  function createPiece(index) {
    const piece = document.createElement('div');
    piece.className = 'piece';
    piece.dataset.index = String(index);
    piece.tabIndex = 0;
    piece.setAttribute('role', 'button');
    piece.setAttribute('aria-pressed', 'false');
    paintPiece(piece, index);
    piece.addEventListener('pointerdown', onPiecePointerDown);
    piece.addEventListener('keydown', onPieceKeydown);
    return piece;
  }

  // Bring the board and tray into view on small screens, below the sticky clock.
  function scrollTableIntoView() {
    const hudOffset = getComputedStyle(els.hud).position === 'sticky' ? els.hud.offsetHeight + 8 : 8;
    const rect = els.table.getBoundingClientRect();
    if (rect.top < hudOffset || rect.bottom > window.innerHeight) {
      window.scrollBy(0, rect.top - hudOffset);
    }
  }

  // options.order and options.race come from a live race; a solo round shuffles itself.
  function startGame(options = {}) {
    if (!game.art) return;
    stopRound();
    game.race = options.race || null;
    scrollTableIntoView();
    const fromRects = game.slots.map((slot) => slot.getBoundingClientRect());
    clearBoard();
    resetCounters();
    if (game.race) game.remaining = Math.max(0, game.race.endsAt - Date.now());

    game.pieces = Array.from({ length: game.total }, (_, i) => createPiece(i));
    const raceOrder = options.order && options.order.length === game.total ? options.order : null;
    const order = raceOrder ? raceOrder.slice() : shuffle(game.pieces.map((_, i) => i));
    order.forEach((pieceIndex, cellIndex) => {
      const piece = game.pieces[pieceIndex];
      piece.setAttribute('aria-label', `Loose piece ${cellIndex + 1}`);
      game.cells[cellIndex].append(piece);
    });

    els.boardCover.hidden = true;
    els.howTo.hidden = true;
    els.tray.hidden = false;
    showPause(false);
    game.status = 'scrambling';
    render();

    const begin = () => {
      if (game.status !== 'scrambling') return;
      // In a race the clock runs to the shared deadline, not a fresh time limit.
      if (game.race) game.remaining = Math.max(0, game.race.endsAt - Date.now());
      game.status = 'playing';
      startTimer();
      render();
      announce(`Go! ${game.total} pieces, ${formatLimit(secondsLeft(game.remaining))} on the clock.`);
    };
    if (reducedMotion()) {
      begin();
      return;
    }
    const animations = playScramble(order, fromRects);
    Promise.all(animations.map((a) => a.finished.catch(() => {}))).then(begin);
  }

  // The finished picture breaks apart: each piece flies from its board spot to the tray.
  function playScramble(order, fromRects) {
    return order.map((pieceIndex, cellIndex) => {
      const piece = game.pieces[pieceIndex];
      const from = fromRects[pieceIndex];
      const to = game.cells[cellIndex].getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const scale = to.width ? from.width / to.width : 1;
      return piece.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transform: 'translate(0px, 0px) scale(1)' },
        ],
        {
          duration: 640,
          delay: 160 + cellIndex * 26,
          easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
          fill: 'backwards',
        },
      );
    });
  }

  function winGame() {
    game.remaining = Math.max(0, game.deadline - performance.now());
    stopRound();
    game.status = 'won';
    const usedMs = game.limitMs - game.remaining;
    const previousBest = getBest(game.picture);
    const isRecord = previousBest === null || usedMs < previousBest;
    if (isRecord) setBest(game.picture, usedMs);
    els.board.classList.add('is-complete');
    render();
    announce('Picture complete!');
    if (game.race) {
      emitRace('end', { outcome: 'won', placed: game.placed, misses: game.misses });
      return;
    }
    game.resultTimer = window.setTimeout(
      () => showResult({ outcome: 'won', usedMs, isRecord, previousBest }),
      reducedMotion() ? 200 : 1100,
    );
  }

  function loseGame() {
    if (game.status !== 'playing') return;
    game.remaining = 0;
    stopRound();
    game.status = 'lost';
    game.slots.forEach((slot, i) => {
      if (slot.classList.contains('is-filled')) return;
      const reveal = document.createElement('div');
      reveal.className = 'reveal';
      paintPiece(reveal, i);
      reveal.setAttribute('aria-hidden', 'true');
      slot.append(reveal);
    });
    els.lid.classList.add('is-over');
    render();
    announce("Time's up.");
    if (game.race) {
      emitRace('end', { outcome: 'lost', placed: game.placed, misses: game.misses });
      return;
    }
    game.resultTimer = window.setTimeout(() => showResult({ outcome: 'lost', usedMs: game.limitMs }), 700);
  }

  function showResult({ outcome, usedMs, isRecord = false, previousBest = null }) {
    game.resultTimer = 0;
    const name = game.picture.name;
    const dialog = els.resultDialog;
    dialog.dataset.outcome = outcome;
    if (outcome === 'won') {
      const spare = formatSeconds(secondsLeft(game.remaining));
      els.resultKicker.textContent = isRecord ? 'New best time' : 'Round complete';
      els.resultTitle.textContent = `${LEVELS[game.level].name} picture complete`;
      if (isRecord && previousBest !== null) {
        els.resultText.textContent = `You rebuilt ${name} with ${spare} to spare and beat your old best of ${formatUsed(previousBest)}.`;
      } else if (isRecord) {
        els.resultText.textContent = `You rebuilt ${name} with ${spare} to spare. That's your first finish on this picture.`;
      } else {
        els.resultText.textContent = `You rebuilt ${name} with ${spare} to spare. Your best is still ${formatUsed(previousBest)}.`;
      }
    } else {
      const missing = game.total - game.placed;
      els.resultKicker.textContent = "Time's up";
      els.resultTitle.textContent = `${game.placed} of ${game.total} pieces placed`;
      els.resultText.textContent = `The ${plural(missing, 'missing piece is', `${missing} missing pieces are`)} shown faintly on the board. Try the same picture again or choose another one.`;
    }
    els.resultTime.textContent = formatUsed(usedMs);
    els.resultPlaced.textContent = `${game.placed}/${game.total}`;
    els.resultMisses.textContent = String(game.misses);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    els.againBtn.focus();
  }

  function onResultClose() {
    const choice = els.resultDialog.returnValue;
    els.resultDialog.returnValue = '';
    if (choice === 'again') {
      startGame();
    } else if (choice === 'pick') {
      resetToIdle();
      els.pictureList.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      const current = game.picture && pictureButtons.get(game.picture.id);
      if (current) current.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------ timer

  function startTimer() {
    stopTimer();
    game.deadline = performance.now() + game.remaining;
    game.timerId = window.setInterval(tick, 100);
    tick();
  }

  function stopTimer() {
    if (game.timerId) window.clearInterval(game.timerId);
    game.timerId = 0;
  }

  function tick() {
    game.remaining = Math.max(0, game.deadline - performance.now());
    const secs = secondsLeft(game.remaining);
    for (const [limit, message] of [
      [60, 'One minute left.'],
      [20, 'Twenty seconds left.'],
    ]) {
      if (secs <= limit && secs > 0 && !game.warned.has(limit)) {
        game.warned.add(limit);
        announce(message);
      }
    }
    renderClock();
    if (game.remaining <= 0) loseGame();
  }

  function pauseGame() {
    // A race can't be paused: everyone shares one clock.
    if (game.status !== 'playing' || game.race) return;
    cancelDrag();
    clearSelection();
    game.remaining = Math.max(0, game.deadline - performance.now());
    stopTimer();
    game.status = 'paused';
    showPause(true);
    render();
    els.resumeBtn.focus();
  }

  function resumeGame() {
    if (game.status !== 'paused') return;
    game.status = 'playing';
    showPause(false);
    startTimer();
    render();
  }

  function showPause(paused) {
    els.pauseCover.hidden = !paused;
    els.table.classList.toggle('is-paused', paused);
    els.board.inert = paused;
    els.tray.inert = paused;
  }

  // ----------------------------------------------------------------- render

  function renderClock() {
    const secs = secondsLeft(game.remaining);
    const text = formatSeconds(secs);
    if (els.clockDigits.textContent !== text) els.clockDigits.textContent = text;
    els.clockFill.style.transform = `scaleX(${Math.min(1, game.remaining / game.limitMs).toFixed(4)})`;
    const timed = game.status === 'playing' || game.status === 'paused' || game.status === 'lost';
    let state = 'calm';
    if (timed && secs <= 20) state = 'danger';
    else if (timed && secs <= 60) state = 'warn';
    if (game.status === 'paused' && state === 'warn') state = 'calm';
    els.clock.dataset.state = state;
  }

  function render() {
    els.placedCount.textContent = `${game.placed}/${game.total}`;
    els.missCount.textContent = String(game.misses);
    const best = getBest(game.picture);
    els.bestTime.textContent = best ? formatUsed(best) : '--:--';

    const loose = game.total - game.placed;
    if (game.status === 'idle' || game.status === 'loading') els.looseCount.textContent = `${game.total} in the box`;
    else if (loose === 0) els.looseCount.textContent = 'The box is empty';
    else els.looseCount.textContent = `${loose} left in the box`;

    const inRound = game.status === 'playing' || game.status === 'paused';
    const pauseLabel = game.status === 'paused' ? 'Resume' : 'Pause';
    els.pauseBtn.dataset.mode = pauseLabel.toLowerCase();
    els.pauseBtn.setAttribute('aria-label', pauseLabel);
    els.pauseText.textContent = pauseLabel;
    const raceRound = Boolean(game.race) && (inRound || game.status === 'scrambling');
    els.pauseBtn.disabled = !inRound || raceRound;
    els.restartBtn.disabled = raceRound || !(inRound || game.status === 'won' || game.status === 'lost');
    els.hud.classList.toggle('is-race', raceRound);

    const locked = !canChangeSetup();
    pictureButtons.forEach((button) => {
      button.disabled = locked;
    });
    els.levels.disabled = locked;
    els.uploadInput.disabled = locked;
    els.uploadLabel.classList.toggle('is-disabled', locked);
    renderNote();

    const playing = game.status === 'playing';
    game.slots.forEach((slot) => {
      slot.tabIndex = playing && !slot.classList.contains('is-filled') ? 0 : -1;
    });
    renderClock();
  }

  // -------------------------------------------------------------- placement

  function attemptPlace(piece, slot, ghost = null) {
    if (game.status !== 'playing' || slot.classList.contains('is-filled')) {
      if (ghost) returnGhost(piece, ghost);
      return;
    }
    if (Number(slot.dataset.index) === Number(piece.dataset.index)) {
      if (ghost) ghost.remove();
      placePiece(piece, slot);
      return;
    }
    game.misses += 1;
    emitRace('progress', { placed: game.placed, misses: game.misses });
    flash(slot, 'is-wrong');
    if (ghost) returnGhost(piece, ghost, () => flash(piece, 'is-shaking'));
    else flash(piece, 'is-shaking');
    announce('Wrong spot. The piece went back to the box.');
    render();
  }

  function placePiece(piece, slot) {
    const focusWasHere = document.activeElement === piece || document.activeElement === slot;
    if (game.selected === piece) clearSelection();
    piece.classList.remove('is-lifted', 'is-selected');
    piece.removeAttribute('role');
    piece.removeAttribute('aria-label');
    piece.removeAttribute('aria-pressed');
    piece.tabIndex = -1;
    slot.append(piece);
    slot.classList.add('is-filled');
    slot.classList.remove('is-target');
    slot.setAttribute('aria-disabled', 'true');
    flash(piece, 'is-snapped');
    game.placed += 1;
    emitRace('progress', { placed: game.placed, misses: game.misses });
    if (game.placed === game.total) {
      winGame();
      return;
    }
    announce(`Placed. ${game.placed} of ${game.total}.`);
    render();
    if (focusWasHere) focusFirstLoosePiece();
  }

  function focusFirstLoosePiece() {
    for (const cell of game.cells) {
      const piece = cell.querySelector('.piece');
      if (piece) {
        piece.focus();
        return;
      }
    }
  }

  // --------------------------------------------------------- tap & keyboard

  function togglePieceSelection(piece) {
    if (game.status !== 'playing') return;
    if (game.selected === piece) {
      clearSelection();
      return;
    }
    clearSelection();
    game.selected = piece;
    piece.classList.add('is-selected');
    piece.setAttribute('aria-pressed', 'true');
    els.board.classList.add('has-selection');
  }

  function clearSelection() {
    if (game.selected) {
      game.selected.classList.remove('is-selected');
      game.selected.setAttribute('aria-pressed', 'false');
    }
    game.selected = null;
    els.board.classList.remove('has-selection');
  }

  function onSlotActivate(slot) {
    if (game.status !== 'playing' || !game.selected || slot.classList.contains('is-filled')) return;
    attemptPlace(game.selected, slot);
  }

  function onPieceKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const piece = event.currentTarget;
    togglePieceSelection(piece);
    if (game.selected === piece) {
      const firstEmpty = game.slots.find((slot) => !slot.classList.contains('is-filled'));
      if (firstEmpty) firstEmpty.focus();
    }
  }

  function onSlotKeydown(event, index) {
    const { cols } = game;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
    if (event.key in moves) {
      event.preventDefault();
      const col = index % cols;
      if (event.key === 'ArrowLeft' && col === 0) return;
      if (event.key === 'ArrowRight' && col === cols - 1) return;
      const next = game.slots[index + moves[event.key]];
      if (next) next.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSlotActivate(event.currentTarget);
    }
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape' && game.selected) {
      const piece = game.selected;
      clearSelection();
      piece.focus();
    }
  }

  // ------------------------------------------------------------------- drag

  function onPiecePointerDown(event) {
    const piece = event.currentTarget;
    if (game.status !== 'playing' || drag || !piece.parentElement.classList.contains('tray-cell')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const rect = piece.getBoundingClientRect();
    drag = {
      piece,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      relX: (event.clientX - rect.left) / rect.width,
      relY: (event.clientY - rect.top) / rect.height,
      ghost: null,
      width: 0,
      height: 0,
      target: null,
    };
    try {
      piece.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; window-level coordinates still work without it.
    }
    piece.addEventListener('pointermove', onPiecePointerMove);
    piece.addEventListener('pointerup', onPiecePointerUp);
    piece.addEventListener('pointercancel', onPiecePointerCancel);
  }

  function onPiecePointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      liftGhost();
    }
    moveGhost(event.clientX, event.clientY);
    setDropTarget(slotAt(event.clientX, event.clientY));
  }

  function onPiecePointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { piece, ghost } = drag;
    if (!ghost) {
      endDrag();
      togglePieceSelection(piece);
      return;
    }
    const slot = slotAt(event.clientX, event.clientY);
    endDrag();
    if (slot && !slot.classList.contains('is-filled')) attemptPlace(piece, slot, ghost);
    else returnGhost(piece, ghost);
  }

  function onPiecePointerCancel(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { piece, ghost } = drag;
    endDrag();
    if (ghost) returnGhost(piece, ghost);
  }

  // Lifting a piece shows a full-size copy (the ghost) under the pointer.
  function liftGhost() {
    clearSelection();
    const board = els.board.getBoundingClientRect();
    const width = board.width / game.cols;
    const height = board.height / game.rows;
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    paintPiece(ghost, Number(drag.piece.dataset.index));
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
    ghost.setAttribute('aria-hidden', 'true');
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.width = width;
    drag.height = height;
    drag.piece.classList.add('is-lifted');
  }

  function moveGhost(x, y) {
    const left = x - drag.relX * drag.width;
    const top = y - drag.relY * drag.height;
    drag.ghost.style.transform = `translate(${left}px, ${top}px) rotate(-2deg)`;
  }

  function slotAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const slot = el && el.closest ? el.closest('.slot') : null;
    return slot && els.board.contains(slot) ? slot : null;
  }

  function setDropTarget(slot) {
    const next = slot && !slot.classList.contains('is-filled') ? slot : null;
    if (drag.target === next) return;
    if (drag.target) drag.target.classList.remove('is-target');
    if (next) next.classList.add('is-target');
    drag.target = next;
  }

  function endDrag() {
    if (!drag) return;
    const { piece, pointerId, target } = drag;
    piece.removeEventListener('pointermove', onPiecePointerMove);
    piece.removeEventListener('pointerup', onPiecePointerUp);
    piece.removeEventListener('pointercancel', onPiecePointerCancel);
    try {
      if (piece.hasPointerCapture(pointerId)) piece.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
    if (target) target.classList.remove('is-target');
    drag = null;
  }

  function cancelDrag() {
    if (!drag) return;
    const { piece, ghost } = drag;
    endDrag();
    if (ghost) ghost.remove();
    piece.classList.remove('is-lifted');
  }

  function returnGhost(piece, ghost, after) {
    const finish = () => {
      ghost.remove();
      piece.classList.remove('is-lifted');
      if (after) after();
    };
    if (reducedMotion() || !piece.isConnected) {
      finish();
      return;
    }
    const rect = piece.getBoundingClientRect();
    const size = parseFloat(ghost.style.width) || rect.width;
    const animation = ghost.animate(
      [{ transform: ghost.style.transform }, { transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / size})` }],
      { duration: 220, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' },
    );
    animation.onfinish = finish;
    animation.oncancel = finish;
  }

  // ------------------------------------------------------------------- boot

  function bindControls() {
    els.startBtn.addEventListener('click', () => startGame());
    els.restartBtn.addEventListener('click', () => startGame());
    els.pauseBtn.addEventListener('click', () => (game.status === 'paused' ? resumeGame() : pauseGame()));
    els.resumeBtn.addEventListener('click', resumeGame);
    els.uploadInput.addEventListener('change', onUpload);
    els.resultDialog.addEventListener('close', onResultClose);
    document.addEventListener('keydown', onDocumentKeydown);
    // The game does its own dragging. Never let the browser start a native drag or
    // accept a native drop: Firefox and Safari navigate away to whatever is dropped.
    document.addEventListener('dragstart', (event) => event.preventDefault());
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseGame();
    });
  }

  // ------------------------------------------------------------- race hooks

  // multiplayer.js runs live races through this small surface.
  window.puzzleGame = {
    pictures: PICTURES.map(({ id, name }) => ({ id, name })),
    levels: Object.fromEntries(
      Object.entries(LEVELS).map(([id, l]) => [id, { name: l.name, pieces: l.cols * l.rows }]),
    ),
    currentSetup,
    on(type, fn) {
      raceHooks[type].push(fn);
    },
    setRoomRole(role) {
      game.roomRole = role;
      render();
    },
    revealBoard: () => scrollTableIntoView(),
    setRank(text) {
      els.rankStat.hidden = !text;
      els.rankValue.textContent = text || '';
    },
    // Show the race's picture and difficulty on the board without starting a round.
    async showSetup({ pictureId, level }) {
      if (game.race || game.status === 'playing' || game.status === 'scrambling') return;
      if (LEVELS[level]) selectLevel(level, { force: true });
      const picture = PICTURES.find((p) => p.id === pictureId);
      if (picture && game.picture?.id !== pictureId) await selectPicture(picture, { force: true });
    },
    async startRace({ id, pictureId, level, order, endsAt }) {
      const picture = PICTURES.find((p) => p.id === pictureId);
      if (!picture || !LEVELS[level]) return;
      stopRound();
      if (game.status === 'playing' || game.status === 'scrambling' || game.status === 'paused') {
        game.status = 'idle';
      }
      selectLevel(level, { force: true });
      if (game.picture?.id !== pictureId) {
        const ok = await selectPicture(picture, { force: true });
        if (!ok) return;
      }
      startGame({ order, race: { id, endsAt } });
    },
    // The race is over on the server. A round still running ends like a time-out;
    // leaving the room mid-race clears the board instead.
    stopRace({ abandon = false } = {}) {
      if (!game.race) return;
      if (abandon) {
        game.race = null;
        resetToIdle();
        return;
      }
      if (game.status === 'playing') loseGame();
      else if (game.status === 'scrambling') resetToIdle();
      game.race = null;
      render();
    },
  };

  applyLevel(storageGet('level'));
  buildBoard();
  buildLevelPicker();
  markActiveLevel();
  buildPictureList();
  bindControls();
  resetCounters();
  render();
  const savedId = storageGet('picture');
  selectPicture(PICTURES.find((p) => p.id === savedId) || PICTURES[0]);
})();
