'use strict';

/*
 * Web simulator for the GeekMagic SmallTV-Ultra firmware.
 *
 * It mirrors the firmware state machine (main.cpp), the RGB565 frame format
 * and the progress bar geometry so the browser preview matches the device.
 *
 * Two data sources are available:
 *   - MockSource: pure client-side scenario player (no Spotify/daemon needed)
 *   - DaemonSource: reads /api/now and /api/art from spotify-smalltv-daemon
 */
(function (global) {
  var SCREEN = 240;
  var FRAME_BYTES = SCREEN * SCREEN * 2;
  var BAND = { x: 0, y: 226, w: 240, h: 14 };
  var BAR = { x: 4, y: 231, w: 232, h: 4 };
  var COLORS = {
    green: '#1DB954',
    barTrack: '#212121',
    white: '#ffffff',
    lightgrey: '#d3d3d3',
    darkgrey: '#a9a9a9',
    orange: '#ffa500',
    black: '#000000'
  };

  var FONT_TITLE = 'bold 24px "Helvetica Neue", Arial, sans-serif';
  var FONT_SMALL = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // ------------------------------------------------------------------
  // RGB565 (little-endian), identical to daemon/spotify_tv/artwork.py
  // ------------------------------------------------------------------

  function decodeRgb565Le(bytes) {
    if (bytes.length !== FRAME_BYTES) {
      throw new Error('art size ' + bytes.length + ' != ' + FRAME_BYTES);
    }
    var image = new ImageData(SCREEN, SCREEN);
    var data = image.data;
    for (var i = 0, p = 0; i < bytes.length; i += 2, p += 4) {
      var value = bytes[i] | (bytes[i + 1] << 8);
      var r = (value >> 11) & 0x1f;
      var g = (value >> 5) & 0x3f;
      var b = value & 0x1f;
      data[p] = (r << 3) | (r >> 2);
      data[p + 1] = (g << 2) | (g >> 4);
      data[p + 2] = (b << 3) | (b >> 2);
      data[p + 3] = 255;
    }
    return image;
  }

  function encodeRgb565Le(rgba) {
    var out = new Uint8Array(FRAME_BYTES);
    for (var i = 0, p = 0; i < out.length; i += 2, p += 4) {
      var value =
        ((rgba[p] & 0xf8) << 8) |
        ((rgba[p + 1] & 0xfc) << 3) |
        (rgba[p + 2] >> 3);
      out[i] = value & 0xff;
      out[i + 1] = (value >> 8) & 0xff;
    }
    return out;
  }

  // Solid #1DB954 frame (the daemon's "no artwork" placeholder)
  function placeholderBytes() {
    var out = new Uint8Array(FRAME_BYTES);
    for (var i = 0; i < out.length; i += 2) {
      out[i] = 0xca;  // 0x1DCA little-endian
      out[i + 1] = 0x1d;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Progress helpers (firmware/src/progress.h)
  // ------------------------------------------------------------------

  function currentPositionMs(now, nowMs) {
    var pos = now.progress_ms || 0;
    if (now.playing) pos += nowMs - now.fetchedAtMs;
    if (now.duration_ms > 0 && pos > now.duration_ms) pos = now.duration_ms;
    return pos;
  }

  function progressRatio(now, nowMs) {
    if (!now.duration_ms) return 0;
    var ratio = currentPositionMs(now, nowMs) / now.duration_ms;
    return Math.max(0, Math.min(1, ratio));
  }

  // ------------------------------------------------------------------
  // Screen (display.cpp)
  // ------------------------------------------------------------------

  function fillRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    ctx.fill();
  }

  function Screen(canvas) {
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.clear();
  }

  Screen.prototype.clear = function () {
    this.ctx.fillStyle = COLORS.black;
    this.ctx.fillRect(0, 0, SCREEN, SCREEN);
  };

  Screen.prototype._text = function (text, y, font, color) {
    var ctx = this.ctx;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, SCREEN / 2, y);
  };

  Screen.prototype._logo = function (cx, cy, radius) {
    var ctx = this.ctx;
    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // 3 black bars, mirrored from drawLogo() in display.cpp
    ctx.fillStyle = COLORS.black;
    for (var i = 0; i < 3; i++) {
      var w = radius + 6 - i * 7;
      var y = cy - 7 + i * 7;
      fillRoundRect(ctx, cx - w / 2, y, w, 3, 2);
    }
  };

  Screen.prototype._header = function (subtitle) {
    this.clear();
    this._logo(SCREEN / 2, 82, 30);
    this._text('Spotify TV', 132, FONT_TITLE, COLORS.white);
    if (subtitle) this._text(subtitle, 162, FONT_SMALL, COLORS.lightgrey);
  };

  Screen.prototype._errorScreen = function (title, line) {
    this.clear();
    this._text(title, 90, FONT_TITLE, COLORS.orange);
    if (line) this._text(line, 128, FONT_SMALL, COLORS.lightgrey);
    this._text('Retrying...', 156, FONT_SMALL, COLORS.darkgrey);
  };

  Screen.prototype.drawArt = function (bytes) {
    this.ctx.putImageData(decodeRgb565Le(bytes), 0, 0);
  };

  Screen.prototype.showBoot = function (subtitle) {
    this._header(subtitle);
  };

  Screen.prototype.showIdle = function () {
    this._header('Not playing');
  };

  Screen.prototype.showError = function (line) {
    this._errorScreen('Connection error', line);
  };

  Screen.prototype.showSpotifyError = function () {
    this._errorScreen('Spotify error', 'Check daemon log');
  };

  Screen.prototype.showArtworkError = function () {
    this._errorScreen('Artwork error', 'Retrying image download');
  };

  Screen.prototype.showWifiError = function () {
    this.clear();
    this._text('Wi-Fi error', 90, FONT_TITLE, COLORS.orange);
    this._text('Check config.h', 128, FONT_SMALL, COLORS.lightgrey);
    this._text('Retrying...', 156, FONT_SMALL, COLORS.darkgrey);
  };

  Screen.prototype.drawBaseBand = function () {
    this.ctx.fillStyle = COLORS.black;
    this.ctx.fillRect(BAND.x, BAND.y, BAND.w, BAND.h);
  };

  Screen.prototype.drawProgressBar = function (ratio) {
    ratio = Math.max(0, Math.min(1, ratio));
    this.drawBaseBand();

    this.ctx.fillStyle = COLORS.barTrack;
    this.ctx.fillRect(BAR.x, BAR.y, BAR.w, BAR.h);

    var filled = Math.round(ratio * BAR.w);
    if (filled > 0) {
      this.ctx.fillStyle = COLORS.green;
      this.ctx.fillRect(BAR.x, BAR.y, filled, BAR.h);
    }
  };

  // ------------------------------------------------------------------
  // Data sources
  // ------------------------------------------------------------------

  function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal, cache: 'no-store' })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('timeout after ' + timeoutMs + ' ms');
        }
        throw new Error('network error (daemon down or CORS)');
      })
      .then(function (response) {
        clearTimeout(timer);
        return response;
      }, function (error) {
        clearTimeout(timer);
        throw error;
      });
  }

  function DaemonSource(baseUrl) {
    this.base = (baseUrl || '').replace(/\/+$/, '');
  }

  DaemonSource.prototype.fetchNow = function () {
    return fetchWithTimeout(this.base + '/api/now', 4000).then(function (res) {
      if (!res.ok) throw new Error('GET /api/now -> ' + res.status);
      return res.json();
    });
  };

  DaemonSource.prototype.fetchArt = function (artId) {
    return fetchWithTimeout(
      this.base + '/api/art/' + encodeURIComponent(artId) + '.bin',
      4000
    ).then(function (res) {
      if (!res.ok) throw new Error('GET art -> ' + res.status);
      return res.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        if (bytes.length !== FRAME_BYTES) {
          throw new Error('art size ' + bytes.length + ' != ' + FRAME_BYTES);
        }
        return bytes;
      });
    });
  };

  var MOCK_DURATION_MS = 35000;
  var MOCK_TRACKS = [
    { title: 'Night Drive', artist: 'Demo Artist' },
    { title: 'Neon Rain', artist: 'Demo Artist' },
    { title: 'Slow Motion', artist: 'Demo Artist' },
    { title: 'Deep Focus', artist: 'Demo Artist' }
  ];

  function MockSource(options) {
    this.now = options.now;
    this.artFactory = options.artFactory;
    this.latency = 90;
    this.reset();
  }

  MockSource.prototype.reset = function () {
    this.index = 0;
    this.playing = true;
    this.startedAt = this.now();
    this.pausedAt = 0;
    this.down = false;
    this.stale = false;
    this.noArt = false;
    this.artBroken = false;
    this.artCache = {};
  };

  MockSource.prototype.pause = function () {
    if (!this.playing) return;
    this.pausedAt = this.position();
    this.playing = false;
  };

  MockSource.prototype.resume = function () {
    if (this.playing) return;
    this.startedAt = this.now() - this.pausedAt;
    this.playing = true;
  };

  MockSource.prototype.next = function () {
    this.index = (this.index + 1) % MOCK_TRACKS.length;
    this.startedAt = this.now();
    this.pausedAt = 0;
  };

  MockSource.prototype.position = function () {
    if (!this.playing) return Math.min(MOCK_DURATION_MS, this.pausedAt);
    var elapsed = this.now() - this.startedAt;
    if (elapsed >= MOCK_DURATION_MS) {
      var over = elapsed - MOCK_DURATION_MS;
      this.index = (this.index + 1) % MOCK_TRACKS.length;
      this.startedAt = this.now() - over;
      elapsed = over;
    }
    return Math.min(MOCK_DURATION_MS, elapsed);
  };

  MockSource.prototype._artId = function () {
    return this.noArt ? 'no-art' : 'mock-' + this.index;
  };

  MockSource.prototype.fetchNow = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (self.down) {
          reject(new Error('network error (daemon down or CORS)'));
          return;
        }
        var track = MOCK_TRACKS[self.index % MOCK_TRACKS.length];
        resolve({
          playing: self.playing,
          track_id: 'mock-track-' + self.index,
          art_id: self._artId(),
          title: track.title,
          artist: track.artist,
          progress_ms: Math.round(self.position()),
          duration_ms: MOCK_DURATION_MS,
          stale: self.stale,
          error: self.stale ? 'SpotifyException' : null
        });
      }, self.latency);
    });
  };

  MockSource.prototype.fetchArt = function (artId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (self.artBroken) {
          reject(new Error('GET art -> 404'));
          return;
        }
        if (Object.prototype.hasOwnProperty.call(self.artCache, artId)) {
          resolve(self.artCache[artId]);
          return;
        }
        var index = artId.indexOf('mock-') === 0
          ? Number(artId.slice('mock-'.length))
          : self.index;
        var bytes = artId === 'no-art'
          ? placeholderBytes()
          : self.artFactory(index);
        self.artCache[artId] = bytes;
        resolve(bytes);
      }, self.latency + 60);
    });
  };

  // ------------------------------------------------------------------
  // Firmware state machine (firmware/src/main.cpp)
  // ------------------------------------------------------------------

  var STATE = {
    Boot: 'Boot',
    WifiError: 'WifiError',
    ConnError: 'ConnError',
    SpotifyError: 'SpotifyError',
    ArtError: 'ArtError',
    Idle: 'Idle',
    Playing: 'Playing'
  };

  function Firmware(options) {
    this.screen = options.screen;
    this.source = options.source;
    this.now = options.now || function () { return Date.now(); };
    this.pollInterval = options.pollInterval || 5000;
    this.onLog = options.onLog || function () {};
    this.onState = options.onState || function () {};
    this.onData = options.onData || function () {};

    this.state = null;
    this.nowPlaying = null;
    this.drawnArtId = '';
    this.lastPollAt = this.now() - this.pollInterval + 700;
    this.lastBarAt = 0;
    this.busy = false;
    this.wifiDown = false;
    this.endOfTrackPolled = false;
    this.heapBase = 33000 + Math.round(Math.random() * 1500);

    this.setState(STATE.Boot);
    this.screen.showBoot('Contacting daemon...');
  }

  Firmware.prototype.setState = function (next) {
    if (this.state === next) return;
    this.state = next;
    switch (next) {
      case STATE.WifiError:
        this.screen.showWifiError();
        break;
      case STATE.ConnError:
        this.screen.showError('Daemon unreachable');
        break;
      case STATE.SpotifyError:
        this.screen.showSpotifyError();
        break;
      case STATE.ArtError:
        this.screen.showArtworkError();
        break;
      case STATE.Idle:
        this.screen.showIdle();
        break;
      case STATE.Boot:
        this.screen.showBoot('Starting...');
        break;
      default:
        break;  // Playing: keep whatever is already on screen
    }
    this.onState(next);
  };

  Firmware.prototype.requestPoll = function () {
    this.lastPollAt = this.now() - this.pollInterval;
  };

  Firmware.prototype.log = function (text, level) {
    this.onLog(text, level);
  };

  Firmware.prototype._heap = function () {
    return this.heapBase + Math.round(Math.sin(this.now() / 9000) * 700);
  };

  Firmware.prototype.frame = function () {
    var self = this;
    var t = this.now();

    if (this.wifiDown) {
      if (this.state !== STATE.WifiError) {
        this.log('[wifi] connection lost');
        this.setState(STATE.WifiError);
      }
      return;
    }

    if (this.state === STATE.WifiError) {
      this.log('[wifi] reconnected');
      this.setState(STATE.Boot);
      this.lastPollAt = t - this.pollInterval;
    }

    if (this.busy) return;

    if (t - this.lastPollAt >= this.pollInterval) {
      this.lastPollAt = t;
      this.pollOnce();
      return;
    }

    if (this.state === STATE.Playing && this.nowPlaying) {
      var position = currentPositionMs(this.nowPlaying, t);
      if (this.nowPlaying.duration_ms > 0 && position >= this.nowPlaying.duration_ms) {
        if (!this.endOfTrackPolled) {
          this.endOfTrackPolled = true;
          this.lastPollAt = t - this.pollInterval;
        }
      } else {
        this.endOfTrackPolled = false;
      }
      if (t - this.lastBarAt >= 1000) {
        this.lastBarAt = t;
        this.screen.drawProgressBar(progressRatio(this.nowPlaying, t));
        this.log('[mem] free heap: ' + this._heap());
      }
    }
  };

  Firmware.prototype.pollOnce = function () {
    var self = this;
    if (this.busy) return Promise.resolve();
    this.busy = true;

    return this.source.fetchNow().then(function (fresh) {
      fresh.fetchedAtMs = self.now();
      var previousTrack = self.nowPlaying ? self.nowPlaying.track_id : null;
      self.nowPlaying = fresh;
      self.onData(fresh);

      if (fresh.stale) {
        self.log('[poll] stale: ' + (fresh.error || 'unknown'), 'warn');
        self.setState(STATE.SpotifyError);
        return;
      }
      if (!fresh.playing) {
        self.setState(STATE.Idle);
        return;
      }
      if (fresh.track_id !== previousTrack) self.endOfTrackPolled = false;

      var needArt =
        self.state !== STATE.Playing || fresh.art_id !== self.drawnArtId;
      if (!needArt) return;

      self.log('[main] fetching art ' + fresh.art_id);
      var started = self.now();
      return self.source.fetchArt(fresh.art_id).then(function (bytes) {
        self.screen.drawArt(bytes);
        self.drawnArtId = fresh.art_id;
        var drawnAt = self.now();
        self.screen.drawBaseBand();
        self.screen.drawProgressBar(progressRatio(fresh, drawnAt));
        self.lastBarAt = drawnAt;
        self.state = STATE.Playing;
        self.onState(STATE.Playing);
        self.log('[art] drawn ' + fresh.art_id + ' in ' +
          Math.round(drawnAt - started) + ' ms');
      }, function (error) {
        self.log('[http] ' + error.message, 'err');
        self.setState(STATE.ArtError);
      });
    }, function (error) {
      self.log('[http] ' + error.message, 'err');
      self.setState(STATE.ConnError);
    }).then(function () {
      self.busy = false;
    }, function () {
      self.busy = false;
    });
  };

  // ------------------------------------------------------------------
  // Browser UI
  // ------------------------------------------------------------------

  function mockArtwork(index) {
    var canvas = document.createElement('canvas');
    canvas.width = SCREEN;
    canvas.height = SCREEN;
    var ctx = canvas.getContext('2d');
    var track = MOCK_TRACKS[index % MOCK_TRACKS.length];
    var hue = (index * 57 + 140) % 360;

    var gradient = ctx.createLinearGradient(0, 0, SCREEN, SCREEN);
    gradient.addColorStop(0, 'hsl(' + hue + ', 58%, 45%)');
    gradient.addColorStop(1, 'hsl(' + ((hue + 65) % 360) + ', 62%, 16%)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SCREEN, SCREEN);

    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(184, 58, 72, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(40, 120, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 168, SCREEN, 58);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(track.title, 16, 196);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = FONT_SMALL;
    ctx.fillText(track.artist, 16, 217);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = 'bold 18px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('#' + (index + 1), 224, 36);

    return encodeRgb565Le(ctx.getImageData(0, 0, SCREEN, SCREEN).data);
  }

  function pad(value, width) {
    var text = String(value);
    while (text.length < width) text = '0' + text;
    return text;
  }

  function init() {
    var canvas = document.getElementById('screen');
    var jsonEl = document.getElementById('json');
    var logEl = document.getElementById('log');
    var stateBadge = document.getElementById('state-badge');
    var modeBadge = document.getElementById('mode-badge');
    var urlEl = document.getElementById('daemon-url');
    var hintEl = document.getElementById('source-hint');
    var pollEl = document.getElementById('poll-interval');
    var mockPanel = document.getElementById('mock-controls');
    var screen = new Screen(canvas);

    var now = function () { return performance.now(); };
    var mock = new MockSource({ now: now, artFactory: mockArtwork });
    var firmware = null;
    var mode = 'mock';

    function log(text, level) {
      var date = new Date();
      var stamp = pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) +
        ':' + pad(date.getSeconds(), 2) + '.' + pad(date.getMilliseconds(), 3);
      var line = document.createElement('div');
      line.className = 'line' + (level ? ' ' + level : '');
      line.textContent = stamp + ' ' + text;
      logEl.appendChild(line);
      while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setMockControlsEnabled(enabled) {
      mockPanel.classList.toggle('is-disabled', !enabled);
      var buttons = mockPanel.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !enabled;
    }

    function start(nextMode) {
      mode = nextMode;
      modeBadge.textContent = mode;
      document.getElementById('src-mock').classList.toggle('active', mode === 'mock');
      document.getElementById('src-live').classList.toggle('active', mode === 'live');
      setMockControlsEnabled(mode === 'mock');
      urlEl.disabled = mode === 'mock';
      hintEl.textContent = mode === 'mock'
        ? 'No Spotify account or daemon required — use the scenarios below to drive the state machine.'
        : 'Reads /api/now and /api/art from the daemon. Cross-origin reads must be allowed by the daemon (CORS) — see the README.';

      var source;
      if (mode === 'mock') {
        mock.reset();
        source = mock;
      } else {
        source = new DaemonSource(urlEl.value);
      }

      firmware = new Firmware({
        screen: screen,
        source: source,
        pollInterval: Math.max(1, Number(pollEl.value) || 5) * 1000,
        now: now,
        onLog: log,
        onState: function (state) {
          stateBadge.textContent = state;
          stateBadge.className = 'badge ' + state;
        },
        onData: function (data) {
          var copy = Object.assign({}, data);
          delete copy.fetchedAtMs;  // simulator-only field
          jsonEl.textContent = JSON.stringify(copy, null, 2);
        }
      });

      log('=== Spotify SmallTV-Ultra (web simulator) ===');
      if (mode === 'mock') {
        log('[wifi] connected: 192.168.1.42');
      } else {
        log('[wifi] connected: ' + (window.location.hostname || 'localhost'));
        log('[main] daemon: ' + (urlEl.value || window.location.origin));
      }
    }

    // --- mock scenario controls -------------------------------------
    // 故障フラグをまとめて解除する (play/pause/next は状態を戻す操作)
    function clearFaults() {
      mock.down = false;
      mock.stale = false;
      mock.noArt = false;
      mock.artBroken = false;
    }

    var actions = {
      play: function () { clearFaults(); mock.resume(); firmware.requestPoll(); },
      pause: function () { clearFaults(); mock.pause(); firmware.requestPoll(); },
      next: function () { clearFaults(); mock.next(); firmware.requestPoll(); },
      noart: function () { mock.noArt = true; firmware.requestPoll(); },
      artfail: function () {
        // アート ID が変わらないとファームは再取得しない (needArt) ので、
        // 曲を進めて「新しい曲のアートが 404」という状況を作る。
        mock.noArt = false;
        mock.artBroken = true;
        mock.next();
        firmware.requestPoll();
      },
      stale: function () { mock.stale = true; firmware.requestPoll(); },
      daemondown: function () { mock.down = true; firmware.requestPoll(); },
      wifidown: function () { firmware.wifiDown = true; },
      reset: function () {
        clearFaults();
        mock.reset();
        firmware.wifiDown = false;
        firmware.requestPoll();
      }
    };

    var actionButtons = document.querySelectorAll('[data-action]');
    for (var i = 0; i < actionButtons.length; i++) {
      actionButtons[i].addEventListener('click', function (event) {
        var action = event.currentTarget.getAttribute('data-action');
        if (actions[action]) actions[action]();
      });
    }

    // --- source / connection controls -------------------------------
    document.getElementById('src-mock').addEventListener('click', function () {
      start('mock');
    });
    document.getElementById('src-live').addEventListener('click', function () {
      start('live');
    });
    document.getElementById('connect').addEventListener('click', function () {
      start('live');
    });
    pollEl.addEventListener('change', function () {
      if (firmware) {
        firmware.pollInterval = Math.max(1, Number(pollEl.value) || 5) * 1000;
        log('[conf] poll interval = ' + firmware.pollInterval + ' ms');
      }
    });

    // Always start on the mock source so the page is useful immediately
    // (GitHub Pages, any static host, or file://). Switch to "Daemon" for live data.
    urlEl.value = 'http://localhost:8888';
    start('mock');

    // ~100 ms tick, like the firmware's loop() delay(10)
    setInterval(function () {
      if (firmware) firmware.frame();
    }, 100);
  }

  global.SmallTV = {
    FRAME_BYTES: FRAME_BYTES,
    BAND: BAND,
    BAR: BAR,
    STATE: STATE,
    Screen: Screen,
    Firmware: Firmware,
    MockSource: MockSource,
    DaemonSource: DaemonSource,
    decodeRgb565Le: decodeRgb565Le,
    encodeRgb565Le: encodeRgb565Le,
    placeholderBytes: placeholderBytes,
    currentPositionMs: currentPositionMs,
    progressRatio: progressRatio,
    MOCK_TRACKS: MOCK_TRACKS,
    MOCK_DURATION_MS: MOCK_DURATION_MS
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
