/*
 * StreamDaemon · SDLayout
 * Persistencia compartida de posiciones del editor Drag & Drop.
 *
 * El editor (iframe de StreamDaemon) y OBS son navegadores distintos con
 * localStorage separado, así que las posiciones se guardan en el backend
 * (GET/PUT /overlays/layout/:key) y se difunden por Socket.IO
 * ('overlay:positions-updated') para que OBS se actualice en vivo.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var BACKEND = (params.get('backend') || 'http://localhost:3000').replace(/\/+$/, '');
  var state = { key: '', map: {}, edit: false, statusEl: null, saveTimer: null, socket: null };

  function sanitize(s) { return String(s || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80); }

  function applyMap(map) {
    Object.keys(map || {}).forEach(function (id) {
      var pos = map[id];
      var el = document.querySelector('[data-widget-id="' + id + '"]');
      if (!el || !pos) return;
      var left = parseFloat(pos.left), top = parseFloat(pos.top);
      if (!isFinite(left) || !isFinite(top)) return;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      if (id === 'alerts') el.style.transform = 'none';
    });
  }

  function setStatus(text, ok) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.style.color = ok === false ? '#ff6b6b' : '#00e676';
  }

  function localKey() { return 'sd_layout_' + state.key; }

  function persist() {
    try { localStorage.setItem(localKey(), JSON.stringify(state.map)); } catch (e) {}
    return fetch(BACKEND + '/overlays/layout/' + encodeURIComponent(state.key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: state.map })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setStatus('✓ Guardado para OBS', true);
    }).catch(function () {
      setStatus('⚠ No se pudo guardar en el servidor', false);
    });
  }

  function connectLive() {
    if (state.edit || state.socket) return;
    var tries = 0;
    (function wait() {
      if (typeof window.io === 'function') {
        state.socket = window.io(BACKEND, { transports: ['websocket'] });
        state.socket.on('overlay:positions-updated', function (msg) {
          if (!msg || msg.key !== state.key) return;
          state.map = msg.positions || {};
          if (Object.keys(state.map).length === 0) location.reload();
          else applyMap(state.map);
        });
        return;
      }
      if (++tries < 40) setTimeout(wait, 500);
    })();
  }

  function obsUrl() {
    var u = new URL(location.href);
    ['edit', 'interactive', 'demo'].forEach(function (k) { u.searchParams.delete(k); });
    if (!u.searchParams.get('backend')) u.searchParams.set('backend', BACKEND);
    // En el editor se carga desde Vite (5173); OBS debe usar el backend (3000).
    var base = new URL(BACKEND);
    if (location.port === '5173') { u.protocol = base.protocol; u.host = base.host; }
    return u.toString();
  }

  window.SDLayout = {
    init: function (opts) {
      state.key = sanitize(opts.overlayId + '_' + (opts.channel || 'default'));
      state.edit = !!opts.edit;
      try {
        var raw = localStorage.getItem(localKey());
        if (raw) { state.map = JSON.parse(raw) || {}; applyMap(state.map); }
      } catch (e) {}
      fetch(BACKEND + '/overlays/layout/' + encodeURIComponent(state.key))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.positions) return;
          state.map = d.positions;
          applyMap(state.map);
          try { localStorage.setItem(localKey(), JSON.stringify(state.map)); } catch (e) {}
        })
        .catch(function () {});
      connectLive();
    },
    setPosition: function (id, left, top) {
      state.map[id] = { left: Math.round(left), top: Math.round(top) };
      clearTimeout(state.saveTimer);
      setStatus('Guardando…', true);
      state.saveTimer = setTimeout(persist, 120);
    },
    reset: function () {
      state.map = {};
      try { localStorage.removeItem(localKey()); } catch (e) {}
      return persist();
    },
    mountToolbar: function () {
      var tb = document.getElementById('edit-toolbar');
      if (!tb || state.statusEl) return;
      var st = document.createElement('span');
      st.style.cssText = 'font:700 12px Arial,sans-serif;letter-spacing:1px;color:#00e676;white-space:nowrap';
      st.textContent = 'Arrastra · se guarda solo para OBS';
      tb.appendChild(st);
      state.statusEl = st;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btn-copy-obs-url';
      btn.className = 'edit-btn';
      btn.textContent = '📋 Copiar URL para OBS';
      btn.addEventListener('click', function () {
        var url = obsUrl();
        var done = function () { setStatus('✓ URL copiada · pégala en OBS', true); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copia esta URL:', url); });
        } else { window.prompt('Copia esta URL:', url); }
      });
      tb.appendChild(btn);
    }
  };
})();

