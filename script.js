(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var cockpit = $('cockpit');
  var menu = $('settingsMenu');
  var hint = $('settingsHint');
  var closeSettings = $('closeSettings');

  var STORAGE_KEY = 'speedoHudLayout';
  var SPEED_LIMIT = 60;   // km/h -> hanya memicu efek visual, TANPA audio
  var RPM_MAX = 9000;
  var REDLINE = 7500;
  var CX = 330, CY = 154;
  var THEMES = ['theme-amber', 'theme-white', 'theme-cyan'];
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ================= STATE ================= */
  var S = {
    engine: false,
    speed: 0,
    speedMS: 0,
    speedMode: 0, // 0: KMH, 1: MPH, 2: Knots
    rpm: 0,
    fuel: 100,
    health: 100,
    gear: 'N',
    lights: 0,
    left: false,
    right: false,
    belt: false,
    odo: 0
  };

  var L = { tx: 0, ty: 0, scale: 1, theme: 0 };
  var mode = null;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function num(v, d) { v = Number(v); return isNaN(v) ? (d || 0) : v; }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = String(value);
  }

  /* ================= SEATBELT CHIME (D5 + A5, sopan & elegan) ================= */
  var audioCtx = null;
  var chimeMaster = null;
  var beltChimeTimer = null;

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  // Satu "ding": chord D5 (587.33Hz) + A5 (880Hz), attack halus, decay panjang, volume rendah
  function strikeChime(ctx, out, when, level) {
    [[587.33, 1], [880, 0.8], [1174.66, 0.12], [1760, 0.06]].forEach(function (p) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p[0], when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(level * p[1], when + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.1);
      osc.connect(gain);
      gain.connect(out);
      osc.start(when);
      osc.stop(when + 1.15);
    });
  }

  function playBeltChime() {
    if (S.belt) return;
    try {
      var ctx = getAudioContext();
      if (!chimeMaster) {
        chimeMaster = ctx.createGain();
        chimeMaster.connect(ctx.destination);
      }
      chimeMaster.gain.cancelScheduledValues(ctx.currentTime);
      chimeMaster.gain.setValueAtTime(0.5, ctx.currentTime);
      var now = ctx.currentTime;
      strikeChime(ctx, chimeMaster, now, 0.06);
      strikeChime(ctx, chimeMaster, now + 0.34, 0.045);
    } catch (e) {}
  }

  function stopBeltChime() {
    if (beltChimeTimer) {
      clearInterval(beltChimeTimer);
      beltChimeTimer = null;
    }
    if (audioCtx && chimeMaster) {
      try {
        var t = audioCtx.currentTime;
        chimeMaster.gain.cancelScheduledValues(t);
        chimeMaster.gain.setValueAtTime(chimeMaster.gain.value, t);
        chimeMaster.gain.linearRampToValueAtTime(0.0001, t + 0.12);
      } catch (e) {}
    }
  }

  function updateBeltChime() {
    if (!S.belt) {
      if (!beltChimeTimer) {
        playBeltChime();
        beltChimeTimer = setInterval(playBeltChime, 3600);
      }
    } else {
      stopBeltChime();
    }
  }

  /* ================= SISTEM YOUTUBE ONLINE ================= */
  var MUSIC_STORAGE_KEY = 'samc_music_playlist_v1';
  var musicPlayer = null;
  var musicApiReady = false;
  var musicReady = false;
  var musicPlaylist = [];
  var musicIndex = -1;
  var musicRepeat = false;
  var musicShuffle = false;
  var musicProgressTimer = null;
  var musicPendingLoad = null;

  function formatMusicTime(seconds) {
    var n = Math.max(0, Math.floor(Number(seconds) || 0));
    var m = Math.floor(n / 60);
    var s = String(n % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function extractYouTubeSource(input) {
    var raw = String(input || '').trim();
    if (!raw) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return { type: 'video', id: raw };
    try {
      var url = new URL(raw);
      var host = url.hostname.toLowerCase();
      var isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be');
      if (!isYoutube) return null;
      var watchId = url.searchParams.get('v');
      if (watchId && /^[a-zA-Z0-9_-]{11}$/.test(watchId)) return { type: 'video', id: watchId };
      var parts = url.pathname.split('/').filter(Boolean);
      var idx = parts.findIndex(function (p) { return ['embed', 'shorts', 'live'].includes(p); });
      if (idx >= 0 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) return { type: 'video', id: parts[idx + 1] };
      if (host === 'youtu.be' && parts[0] && /^[a-zA-Z0-9_-]{11}$/.test(parts[0])) return { type: 'video', id: parts[0] };
    } catch (_) {}
    return null;
  }

  function youtubeThumbnail(id) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg';
  }

  function loadMusicPlaylist() {
    try {
      var raw = localStorage.getItem(MUSIC_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        musicPlaylist = parsed.filter(function (item) { return item && item.id; }).map(function (item) {
          return { id: String(item.id), title: String(item.title || 'YouTube Track') };
        });
      }
    } catch (_) {
      musicPlaylist = [];
    }
  }

  function saveMusicPlaylist() {
    try { localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify(musicPlaylist)); } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderMusicPlaylist() {
    var list = $('music-playlist');
    if (!list) return;
    list.innerHTML = '';
    if (!musicPlaylist.length) {
      var empty = document.createElement('div');
      empty.className = 'music-empty';
      empty.textContent = 'Playlist kosong. Tekan + untuk menambah lagu.';
      list.appendChild(empty);
      return;
    }
    musicPlaylist.forEach(function (track, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'music-track-row' + (index === musicIndex ? ' active' : '');
      row.innerHTML =
        '<span class="music-track-thumb"><img src="' + youtubeThumbnail(track.id) + '" alt=""></span>' +
        '<span class="music-track-copy"><strong>' + escapeHtml(track.title) + '</strong></span>' +
        '<span class="music-track-index">' + String(index + 1).padStart(2, '0') + '</span>';
      row.addEventListener('click', function () { playMusicIndex(index); });
      list.appendChild(row);
    });
  }

  function updateMusicMeta() {
    var title = $('music-track-title');
    var subtitle = $('music-track-subtitle');
    var cover = $('music-cover');
    var placeholder = $('music-player-placeholder');
    var track = musicPlaylist[musicIndex];

    if (title) title.textContent = track ? track.title : 'Belum ada lagu';
    if (subtitle) subtitle.textContent = track ? 'YouTube • Playing' : 'Online Playback';
    if (cover) {
      if (track) {
        cover.src = youtubeThumbnail(track.id);
        cover.classList.add('show');
        cover.onerror = function () { cover.classList.remove('show'); };
      } else {
        cover.removeAttribute('src');
        cover.classList.remove('show');
      }
    }
    if (placeholder) placeholder.classList.toggle('hide', !!track);
    renderMusicPlaylist();
  }

  function updateMusicPlayButton() {
    var btn = $('btn-music-play');
    if (!btn) return;
    var state = musicPlayer && typeof musicPlayer.getPlayerState === 'function' ? musicPlayer.getPlayerState() : -1;
    btn.textContent = state === 1 ? '❚❚' : '▶';
  }

  function startMusicProgressLoop() {
    if (musicProgressTimer) return;
    musicProgressTimer = setInterval(function () {
      if (!musicPlayer || !musicReady) return;
      var current = 0, duration = 0;
      try {
        current = Number(musicPlayer.getCurrentTime()) || 0;
        duration = Number(musicPlayer.getDuration()) || 0;
      } catch (_) { return; }
      var progress = $('music-progress');
      var now = $('music-current-time');
      var end = $('music-duration');
      if (now) now.textContent = formatMusicTime(current);
      if (end) end.textContent = formatMusicTime(duration);
      if (progress) progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
    }, 250);
  }

  function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) {
      musicApiReady = true;
      initializeYouTubePlayer();
      return;
    }
    if (window.__samcYouTubeApiLoading) return;
    window.__samcYouTubeApiLoading = true;
    window.onYouTubeIframeAPIReady = function () {
      musicApiReady = true;
      initializeYouTubePlayer();
    };
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = function () {
      var subtitle = $('music-track-subtitle');
      if (subtitle) subtitle.textContent = 'API gagal dimuat. Cek koneksi internet.';
    };
    document.head.appendChild(tag);
  }

  function initializeYouTubePlayer() {
    if (!musicApiReady || musicPlayer || !$('youtube-player')) return;
    musicPlayer = new YT.Player('youtube-player', {
      width: '90',
      height: '52',
      videoId: musicPlaylist[0] ? musicPlaylist[0].id : '',
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        controls: 0,
        fs: 0,
        disablekb: 1,
        origin: window.location.origin
      },
      events: {
        onReady: function (event) {
          musicReady = true;
          event.target.setVolume(Number($('music-volume')?.value || 80));
          $('music-player-placeholder')?.classList.toggle('hide', !!musicPlaylist.length);
          updateMusicPlayButton();
          startMusicProgressLoop();
          if (musicPendingLoad !== null) {
            var pending = musicPendingLoad;
            musicPendingLoad = null;
            playMusicIndex(pending);
          }
        },
        onStateChange: function (event) {
          updateMusicPlayButton();
          if (event.data === YT.PlayerState.ENDED) {
            playNextMusic(true);
          }
          var placeholder = $('music-player-placeholder');
          if (placeholder) placeholder.classList.toggle('hide', event.data !== YT.PlayerState.UNSTARTED || !musicPlaylist.length);
        },
        onError: function () {
          var subtitle = $('music-track-subtitle');
          if (subtitle) subtitle.textContent = 'Lagu diblokir / tidak dapat diputar.';
        }
      }
    });
  }

  function addMusicTrack(input, titleOverride) {
    var source = extractYouTubeSource(input);
    if (!source || source.type !== 'video') {
      alert('Masukkan link YouTube / ID 11 karakter yang valid.');
      return false;
    }
    var title = String(titleOverride || '').trim() || ('YouTube • ' + source.id);
    var existing = musicPlaylist.findIndex(function (item) { return item.id === source.id; });
    if (existing === -1) {
      musicPlaylist.push({ id: source.id, title: title });
      musicIndex = musicPlaylist.length - 1;
    } else {
      musicIndex = existing;
    }
    saveMusicPlaylist();
    renderMusicPlaylist();
    updateMusicMeta();
    playMusicIndex(musicIndex);
    return true;
  }

  function playMusicIndex(index) {
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= musicPlaylist.length) return;
    musicIndex = index;
    updateMusicMeta();

    if (!musicReady) {
      musicPendingLoad = index;
      ensureYouTubeAPI();
      return;
    }
    var track = musicPlaylist[index];
    try {
      musicPlayer.loadVideoById(track.id);
      musicPlayer.playVideo();
      setText('aiMessage', 'MUSIC PLAYING');
    } catch (_) {}

    $('music-player-placeholder')?.classList.add('hide');
  }

  function toggleMusicPlayback() {
    if (!musicReady) {
      if (!musicPlaylist.length) {
        $('music-add-row')?.classList.remove('hide');
        $('music-url-input')?.focus();
        return;
      }
      ensureYouTubeAPI();
      if (musicIndex < 0) musicIndex = 0;
      musicPendingLoad = musicIndex;
      return;
    }
    var state = musicPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      musicPlayer.pauseVideo();
    } else {
      musicPlayer.playVideo();
    }
  }

  function playNextMusic(auto) {
    if (!musicPlaylist.length) return;
    if (musicRepeat && musicIndex >= 0) {
      playMusicIndex(musicIndex);
      return;
    }
    var next;
    if (musicShuffle && musicPlaylist.length > 1) {
      do { next = Math.floor(Math.random() * musicPlaylist.length); } while (next === musicIndex);
    } else {
      next = musicIndex + 1;
      if (next >= musicPlaylist.length) {
        if (auto) next = 0;
        else return;
      }
    }
    playMusicIndex(next);
  }

  function playPrevMusic() {
    if (!musicPlaylist.length) return;
    var prev = musicIndex - 1;
    if (prev < 0) prev = musicPlaylist.length - 1;
    playMusicIndex(prev);
  }

  function setupMusicPlayer() {
    var play = $('btn-music-play');
    var next = $('btn-music-next');
    var prev = $('btn-music-prev');
    var mute = $('btn-music-mute');
    var volume = $('music-volume');
    var progress = $('music-progress');
    var addToggle = $('btn-music-add-toggle');
    var addRow = $('music-add-row');
    var addBtn = $('btn-music-add');
    var urlInput = $('music-url-input');
    var titleInput = $('music-title-input');
    var clear = $('btn-music-clear');
    var repeat = $('btn-music-repeat');
    var shuffle = $('btn-music-shuffle');

    loadMusicPlaylist();
    musicIndex = musicPlaylist.length ? 0 : -1;
    renderMusicPlaylist();
    updateMusicMeta();
    startMusicProgressLoop();

    if (play) play.addEventListener('click', function (e) { e.stopPropagation(); toggleMusicPlayback(); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); playNextMusic(false); });
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); playPrevMusic(); });

    if (volume) volume.addEventListener('input', function () {
      if (musicPlayer && musicReady) musicPlayer.setVolume(Number(volume.value));
    });

    if (mute) mute.addEventListener('click', function () {
      if (!musicPlayer || !musicReady) return;
      if (musicPlayer.isMuted()) {
        musicPlayer.unMute();
        mute.textContent = '🔊';
      } else {
        musicPlayer.mute();
        mute.textContent = '🔇';
      }
    });

    if (progress) progress.addEventListener('input', function () {
      if (!musicPlayer || !musicReady) return;
      var duration = Number(musicPlayer.getDuration()) || 0;
      if (duration > 0) musicPlayer.seekTo((Number(progress.value) / 1000) * duration, true);
    });

    if (addToggle) addToggle.addEventListener('click', function () {
      addRow?.classList.toggle('hide');
      urlInput?.focus();
    });

    var addFromInputs = function () {
      if (addMusicTrack(urlInput?.value || '', titleInput?.value || '')) {
        if (urlInput) urlInput.value = '';
        if (titleInput) titleInput.value = '';
        addRow?.classList.add('hide');
      }
    };

    if (addBtn) addBtn.addEventListener('click', addFromInputs);
    [urlInput, titleInput].forEach(function (el) {
      el?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addFromInputs();
      });
    });

    if (clear) clear.addEventListener('click', function () {
      musicPlaylist = [];
      musicIndex = -1;
      saveMusicPlaylist();
      renderMusicPlaylist();
      updateMusicMeta();
      if (musicPlayer && musicReady) musicPlayer.stopVideo();
    });

    if (repeat) repeat.addEventListener('click', function () {
      musicRepeat = !musicRepeat;
      repeat.classList.toggle('active', musicRepeat);
    });

    if (shuffle) shuffle.addEventListener('click', function () {
      musicShuffle = !musicShuffle;
      shuffle.classList.toggle('active', musicShuffle);
    });

    if (musicPlaylist.length) ensureYouTubeAPI();
  }

  /* ================= DIAL TACHOMETER 0 - 9000 RPM ================= */
  function pt(r, a) {
    var rad = a * Math.PI / 180;
    return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
  }
  function ang(rpm) { return -135 + (rpm / RPM_MAX) * 270; }

  function svgEl(name, attrs, parent) {
    var el = document.createElementNS(SVGNS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  function buildDial() {
    var g = $('dialMarks');
    if (!g) return;
    var r, a, p1, p2, major, mid, red, ln;

    // pita redline 7500 - 9000
    var s = pt(104, ang(REDLINE)), e = pt(104, ang(RPM_MAX));
    svgEl('path', { 'class': 'redband', d: 'M' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) + ' A104 104 0 0 1 ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2) }, g);

    for (r = 0; r <= RPM_MAX; r += 250) {
      a = ang(r);
      major = r % 1000 === 0;
      mid = r % 500 === 0;
      red = r >= REDLINE;
      p1 = pt(100, a);
      p2 = pt(major ? 84 : (mid ? 89 : 94), a);
      ln = svgEl('line', {
        x1: p1[0].toFixed(2), y1: p1[1].toFixed(2), x2: p2[0].toFixed(2), y2: p2[1].toFixed(2),
        'stroke-width': major ? 2.8 : (mid ? 1.8 : 1.1),
        'class': red ? 'red' : (major || mid ? '' : 'minor')
      }, g);
    }

    // gerigi redline (serrated teeth) setiap 125 rpm
    for (r = REDLINE + 125; r < RPM_MAX; r += 250) {
      a = ang(r);
      p1 = pt(100, a);
      p2 = pt(95, a);
      svgEl('line', { x1: p1[0].toFixed(2), y1: p1[1].toFixed(2), x2: p2[0].toFixed(2), y2: p2[1].toFixed(2), 'stroke-width': 2.2, 'class': 'red' }, g);
    }

    // angka 0 - 9
    for (r = 0; r <= RPM_MAX; r += 1000) {
      p1 = pt(70, ang(r));
      var t = svgEl('text', { x: p1[0].toFixed(2), y: p1[1].toFixed(2), 'class': 'num' + (r >= 8000 ? ' red' : '') }, g);
      t.textContent = String(r / 1000);
    }
    var lbl = svgEl('text', { x: CX, y: 108, 'class': 'rpm-x' }, g);
    lbl.textContent = 'RPM x1000';
  }

  /* ================= LOOP ANIMASI JARUM (smooth, boot sweep, flutter) ================= */
  var needle = $('needle');
  var needleShadow = $('needleShadow');
  var BOOT_MS = 1800;
  var boot = { on: false, t0: 0 };
  var dispRPM = 0;
  var ledKey = '';
  var LED_STEPS = [5500, 6300, 7000, 7700, 8300];

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function startBoot() {
    boot.on = true;
    boot.t0 = performance.now();
    cockpit.classList.add('booting');
    renderEngineCheck();
  }

  function frame(now) {
    var target;
    if (boot.on) {
      var t = (now - boot.t0) / BOOT_MS;
      if (t >= 1) {
        boot.on = false;
        cockpit.classList.remove('booting');
        renderEngineCheck();
        target = S.rpm;
        dispRPM = 0;
      } else {
        var half = t < 0.5 ? ease(t * 2) : 1 - ease(t * 2 - 1);
        dispRPM = half * RPM_MAX;
        target = dispRPM;
      }
    } else {
      target = clamp(S.rpm, 0, RPM_MAX);
      dispRPM += (target - dispRPM) * 0.22;
    }

    var a = ang(clamp(dispRPM, 0, RPM_MAX));
    if (!boot.on && cockpit.classList.contains('overspeed')) {
      // flutter tremor mikro: getaran aerodinamis di kecepatan puncak
      a += Math.sin(now * 0.085) * 0.7 + Math.sin(now * 0.213) * 0.45 + Math.sin(now * 0.47) * 0.25;
    }
    var tf = 'rotate(' + a.toFixed(2) + ' ' + CX + ' ' + CY + ')';
    if (needle) needle.setAttribute('transform', tf);
    if (needleShadow) needleShadow.setAttribute('transform', 'translate(5 8) ' + tf);

    // shift light bertingkat: hijau -> kuning -> merah, kedip cepat dekat rev limit
    var lit = 0;
    for (var i = 0; i < LED_STEPS.length; i++) if (dispRPM >= LED_STEPS[i]) lit = i + 1;
    var blink = dispRPM >= 8600;
    var key = lit + '|' + blink;
    if (key !== ledKey) {
      ledKey = key;
      for (var j = 0; j < 5; j++) {
        var led = $('led' + j);
        if (led) led.classList.toggle('on', j < lit);
      }
      cockpit.classList.toggle('shift-blink', blink);
    }
    requestAnimationFrame(frame);
  }

  /* ================= RENDER HUD ================= */
  function renderRPM() {
    cockpit.classList.toggle('redline', S.rpm >= REDLINE);
  }

  function renderSpeed() {
    setText('speedValue', String(Math.round(S.speed)).padStart(3, '0'));
    setText('speedUnit', S.speedMode === 1 ? 'MPH' : (S.speedMode === 2 ? 'KNOTS' : 'KM/H'));
    // overspeed: hanya kelas visual (cincin merah, angka menyala, jarum bergetar) - tanpa audio
    cockpit.classList.toggle('overspeed', (S.speedMS * 3.6) >= SPEED_LIMIT);
  }

  function renderGear() {
    setText('gearValue', S.gear);
    var cells = document.querySelectorAll('#gearStrip i');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('on', cells[i].getAttribute('data-g') === S.gear);
    }
  }

  function renderHeadlights() {
    var el = $('headlightIndicator');
    if (el) {
      el.className = 'vehicle-indicator' + (S.lights !== 0 ? ' active' : '') + (S.lights === 2 ? ' high' : '');
      el.title = S.lights === 2 ? 'High Beam' : (S.lights === 1 ? 'Low Beam' : 'Headlights');
    }
    setText('headlightMode', S.lights === 2 ? 'HIGH BEAM' : (S.lights === 1 ? 'LOW BEAM' : 'LIGHTS OFF'));
  }

  function renderIndicators() {
    $('leftIndicator').classList.toggle('active', S.left);
    $('rightIndicator').classList.toggle('active', S.right);
    cockpit.classList.toggle('hazard-active', S.left && S.right);
  }

  function renderOdometer() {
    var box = $('odometerValue');
    if (!box) return;
    var n = Math.max(0, S.odo);
    var parts = n.toFixed(1).split('.');
    var str = parts[0].padStart(6, '0').slice(-6) + parts[1];
    box.innerHTML = '';
    for (var i = 0; i < str.length; i++) {
      var d = document.createElement('i');
      d.textContent = str.charAt(i);
      if (i === str.length - 1) d.className = 'dec';
      box.appendChild(d);
    }
  }

  function renderEngineCheck() {
    var icon = $('engineCheck');
    if (!icon) return;
    // lampu engine check: uji lampu saat booting, menyala amber saat kondisi mesin < 40%
    var lit = boot.on || S.health < 40;
    icon.className = 'vehicle-indicator' + (lit ? ' active warn' : '');
  }

  function renderEngine() {
    cockpit.classList.toggle('engine-off', !S.engine);
    renderEngineCheck();
  }

  function renderSeatbelt() {
    var icon = $('seatbeltIndicator');
    if (icon) icon.className = 'vehicle-indicator' + (!S.belt ? ' active danger' : '');
    cockpit.classList.toggle('belt-unfastened', !S.belt);
  }

  function renderFuel() {
    var f = clamp(S.fuel, 0, 100);
    setText('fuelValue', Math.round(f) + '%');
    var fill = $('fuelFill');
    if (fill) fill.style.width = f + '%';
    cockpit.classList.toggle('fuel-critical', f <= 15);
  }

  function renderHealth() {
    var h = clamp(S.health, 0, 100);
    setText('healthValue', Math.round(h) + '%');
    var fill = $('healthFill');
    if (fill) fill.style.width = h + '%';
    cockpit.classList.toggle('hp-high', h >= 80);
    cockpit.classList.toggle('hp-hurt', h < 80);
    cockpit.classList.toggle('hp-weak', h < 20);
    cockpit.classList.toggle('health-critical', h <= 15);
    renderEngineCheck();
  }

  function updateClock() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var el = $('clockValue');
    if (el) el.innerHTML = hh + '<em>:</em>' + mm;
  }

  /* ================= HOOKS SERVER (FiveM / NUI) ================= */
  window.setEngine = function (engineState) {
    var was = S.engine;
    S.engine = Boolean(engineState);
    renderEngine();
    if (S.engine && !was) startBoot(); // kalibrasi full sweep saat kunci kontak aktif
  };

  window.setSpeed = function (speedMS) {
    var s = Number(speedMS);
    if (isNaN(s)) s = 0;
    S.speedMS = s;
    switch (S.speedMode) {
      case 1: S.speed = Math.round(s * 2.236936); break; // MPH
      case 2: S.speed = Math.round(s * 1.943844); break; // Knots
      default: S.speed = Math.round(s * 3.6); break;      // KMH
    }
    renderSpeed();
  };

  window.setRPM = function (rpmVal) {
    var v = num(rpmVal);
    S.rpm = v <= 1.5 ? v * RPM_MAX : v; // nilai 0-1 dari server dipetakan ke 0-9000
    renderRPM();
  };

  window.setFuel = function (fuelVal) {
    var v = num(fuelVal);
    S.fuel = v <= 1 ? v * 100 : v;
    renderFuel();
  };

  window.setHealth = function (healthVal) {
    var v = num(healthVal);
    S.health = v <= 1 ? v * 100 : (v > 100 ? v / 10 : v);
    renderHealth();
  };

  window.setGear = function (gearVal) {
    S.gear = (gearVal === 0 || gearVal === '0') ? 'N' : String(gearVal).toUpperCase();
    renderGear();
  };

  window.setHeadlights = function (lightState) {
    S.lights = num(lightState);
    renderHeadlights();
  };

  window.setLeftIndicator = function (indicatorState) {
    S.left = Boolean(indicatorState);
    renderIndicators();
  };

  window.setRightIndicator = function (indicatorState) {
    S.right = Boolean(indicatorState);
    renderIndicators();
  };

  window.setSeatbelts = function (seatbeltState) {
    S.belt = Boolean(seatbeltState);
    renderSeatbelt();
    updateBeltChime(); // chime berulang selama belum terpasang, otomatis berhenti saat terpasang
  };

  window.setSpeedMode = function (modeVal) {
    var m = String(modeVal).toLowerCase();
    if (m === 'mph' || m === '1') S.speedMode = 1;
    else if (m === 'knots' || m === 'knot' || m === '2') S.speedMode = 2;
    else S.speedMode = 0;
    window.setSpeed(S.speedMS);
  };

  window.setOdometer = function (dist) {
    S.odo = num(dist);
    renderOdometer();
  };

  /* ================= PENGATURAN HUD & LAYOUT ================= */
  function applyLayout() {
    cockpit.style.setProperty('--tx', L.tx + 'px');
    cockpit.style.setProperty('--ty', L.ty + 'px');
    cockpit.style.setProperty('--scale', L.scale);
    THEMES.forEach(function (t) { cockpit.classList.remove(t); });
    cockpit.classList.add(THEMES[L.theme] || THEMES[0]);
  }

  function clampLayout() {
    L.scale = clamp(L.scale, 0.5, 2);
    applyLayout();
    var r = cockpit.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (r.left < 0) L.tx += -r.left;
    if (r.right > vw) L.tx -= (r.right - vw);
    if (r.top < 0) L.ty += -r.top;
    if (r.bottom > vh) L.ty -= (r.bottom - vh);
    applyLayout();
  }

  function saveLayout() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(L)); } catch (e) {}
  }

  function loadLayout() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      L.tx = num(o.tx); L.ty = num(o.ty);
      L.scale = clamp(num(o.scale, 1), 0.5, 2);
      L.theme = clamp(parseInt(o.theme, 10) || 0, 0, THEMES.length - 1);
    } catch (e) {}
  }

  var HINTS = {
    none: 'Pilih mode · klik kanan untuk menutup menu',
    move: 'Mode PINDAH: tahan & geser mouse untuk memindahkan HUD',
    resize: 'Mode RESIZE: geser mouse atau scroll untuk ubah ukuran',
    reset: 'Posisi & ukuran dikembalikan ke default',
    theme: 'Tema warna HUD diganti'
  };

  function setMode(m, hintKey) {
    mode = m;
    cockpit.classList.toggle('mode-move', m === 'move');
    cockpit.classList.toggle('mode-resize', m === 'resize');
    var btns = menu.querySelectorAll('.menu-btns button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-act') === m);
    }
    hint.textContent = HINTS[hintKey || m || 'none'];
  }

  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || e.button !== 0) return;
    var act = b.getAttribute('data-act');
    if (act === 'move' || act === 'resize') {
      setMode(mode === act ? null : act);
    } else if (act === 'reset') {
      L.tx = 0; L.ty = 0; L.scale = 1;
      setMode(null, 'reset');
      clampLayout(); saveLayout();
    } else if (act === 'theme') {
      L.theme = (L.theme + 1) % THEMES.length;
      applyLayout(); saveLayout();
      hint.textContent = HINTS.theme;
    }
  });

  if (closeSettings) {
    closeSettings.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.remove('open');
      setMode(null);
    });
  }

  cockpit.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    if (!open) setMode(null);
    else setMode(mode);
  });

  var drag = null;
  var dragged = false;

  cockpit.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !mode) return;
    if (e.target.closest('#settingsMenu')) return;
    e.preventDefault();
    dragged = false;
    drag = { x: e.clientX, y: e.clientY, tx: L.tx, ty: L.ty, scale: L.scale };
  });

  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
    if (mode === 'move') {
      L.tx = drag.tx + dx;
      L.ty = drag.ty + dy;
    } else if (mode === 'resize') {
      L.scale = drag.scale - dy / 220;
    }
    clampLayout();
  });

  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = null;
    saveLayout();
    setTimeout(function () { dragged = false; }, 0);
  });

  window.addEventListener('wheel', function (e) {
    if (mode !== 'resize' || !menu.classList.contains('open')) return;
    e.preventDefault();
    L.scale += (e.deltaY < 0 ? 0.05 : -0.05);
    clampLayout(); saveLayout();
  }, { passive: false });

  window.addEventListener('resize', function () { clampLayout(); });

  /* ================= INIT ================= */
  loadLayout();
  clampLayout();
  setMode(null);
  buildDial();
  setupMusicPlayer();
  updateClock();
  setInterval(updateClock, 5000);

  var logo = $('clusterLogo');
  if (logo) logo.addEventListener('error', function () { logo.style.visibility = 'hidden'; });

  window.setEngine(false);
  window.setSpeed(0);
  window.setRPM(0);
  window.setFuel(100);
  window.setHealth(100);
  window.setGear('N');
  window.setHeadlights(0);
  window.setLeftIndicator(false);
  window.setRightIndicator(false);
  window.setSeatbelts(false);
  window.setOdometer(0);

  startBoot();              // sweep kalibrasi saat HUD pertama dimuat
  requestAnimationFrame(frame);

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    var payload = d.data && typeof d.data === 'object' ? d.data : d;

    var aliases = {
      engine: 'setEngine',
      speed: 'setSpeed',
      rpm: 'setRPM',
      fuel: 'setFuel',
      health: 'setHealth',
      gear: 'setGear',
      headlights: 'setHeadlights',
      leftIndicator: 'setLeftIndicator',
      rightIndicator: 'setRightIndicator',
      seatbelts: 'setSeatbelts',
      seatbelt: 'setSeatbelts',
      speedMode: 'setSpeedMode',
      odometer: 'setOdometer'
    };

    for (var key in aliases) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        var fn = window[aliases[key]];
        if (typeof fn === 'function') fn(payload[key]);
      }
    }
  });
})();
