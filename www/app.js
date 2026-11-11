(function () {
  'use strict';

  /* ------------------------------------------------------------ */
  /* Utilidades                                                    */
  /* ------------------------------------------------------------ */
  var API = String(window.BRCORRIDA_API || '').replace(/\/$/, '');
  var $ = function (s) { return document.querySelector(s); };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function money(n) { return 'R$ ' + Number(n).toFixed(2).replace('.', ','); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sem storage */ } return null; }

  var PAY = { dinheiro: 'Dinheiro', pix_motorista: 'Pix (pagar ao motorista)' };
  var ICON = { carro: '🚗', moto: '🏍️' };
  var STATUS_LABEL = { completed: 'Concluída', cancelled: 'Cancelada', no_driver: 'Sem motorista' };

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }

  /* ------------------------------------------------------------ */
  /* Estado                                                        */
  /* ------------------------------------------------------------ */
  var token = store('brc_token') || '';
  var me = null;
  var map = null;
  var L = window.L;
  var pos = null; // GPS atual
  var origin = null; // {lat,lng,address}
  var originCustom = false;
  var dest = null;
  var estimate = null;
  var category = 'carro';
  var payment = 'dinheiro';
  var ride = null; // corrida ativa vinda do servidor
  var pendingRating = null;
  var skipRating = null;
  var mode = 'idle'; // idle | pickOrigin | pickDest | choose
  var query = '';
  var results = [];
  var stars = 0;
  var busy = false;
  var pollTimer = null;
  var rideSig = '';
  var routeForRide = null; // id da corrida cujo trajeto já foi buscado
  var rideRoute = null;
  var markers = {};
  var routeLine = null;
  var lastFitKey = '';

  /* ------------------------------------------------------------ */
  /* API                                                           */
  /* ------------------------------------------------------------ */
  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && token && path.indexOf('/api/auth') !== 0) {
          logout();
          throw new Error('Sua sessão expirou. Entre de novo.');
        }
        if (!res.ok) throw new Error(data.error || 'Erro (' + res.status + ')');
        return data;
      });
    }, function () { throw new Error('Sem conexão com o servidor'); });
  }

  /* ------------------------------------------------------------ */
  /* Login / cadastro                                              */
  /* ------------------------------------------------------------ */
  function showAuth() {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    clearInterval(pollTimer);
  }
  function setTab(login) {
    $('#tab-login').classList.toggle('on', login);
    $('#tab-register').classList.toggle('on', !login);
    $('#f-login').classList.toggle('hidden', !login);
    $('#f-register').classList.toggle('hidden', login);
    $('#auth-error').textContent = '';
  }
  $('#tab-login').onclick = function () { setTab(true); };
  $('#tab-register').onclick = function () { setTab(false); };

  function submitAuth(e, path, extra) {
    e.preventDefault();
    var f = e.target;
    var btn = f.querySelector('button[type=submit]');
    var body = { role: 'passenger' };
    new FormData(f).forEach(function (v, k) { body[k] = v; });
    for (var k in extra) body[k] = extra[k];
    btn.disabled = true;
    $('#auth-error').textContent = '';
    api('POST', path, body).then(function (r) {
      token = r.token;
      store('brc_token', token);
      me = r.user;
      f.reset();
      startApp();
    }).catch(function (err) {
      $('#auth-error').textContent = err.message;
    }).then(function () { btn.disabled = false; });
  }
  $('#f-login').onsubmit = function (e) { submitAuth(e, '/api/auth/login', {}); };
  $('#f-register').onsubmit = function (e) { submitAuth(e, '/api/auth/register', {}); };

  function logout() {
    token = '';
    me = null;
    store('brc_token', null);
    ride = null; pendingRating = null; dest = null; estimate = null; mode = 'idle';
    showAuth();
  }
  $('#btn-logout').onclick = function () {
    if (ride && !confirm('Você tem uma corrida em andamento. Sair mesmo assim?')) return;
    $('#menu').classList.add('hidden');
    logout();
  };

  /* ------------------------------------------------------------ */
  /* Mapa                                                          */
  /* ------------------------------------------------------------ */
  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView(window.BRCORRIDA_CENTER || [-15.79, -47.88], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    map.on('click', function (e) {
      if (mode === 'pickOrigin') setPoint('origin', e.latlng.lat, e.latlng.lng);
      else if (mode === 'pickDest') setPoint('dest', e.latlng.lat, e.latlng.lng);
    });
  }

  function icon(cls, size) {
    return L.divIcon({ className: '', html: '<div class="' + cls + '"></div>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  function carIcon() {
    return L.divIcon({ className: '', html: '<div class="mk-car">' + (ride && ride.category === 'moto' ? '🏍️' : '🚗') + '</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
  }
  function setMarker(key, latlng, ic) {
    if (!latlng) {
      if (markers[key]) { map.removeLayer(markers[key]); delete markers[key]; }
      return;
    }
    if (markers[key]) { markers[key].setLatLng(latlng); markers[key].setIcon(ic); }
    else markers[key] = L.marker(latlng, { icon: ic, interactive: false }).addTo(map);
  }
  function setRoute(geometry) {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (geometry && geometry.length > 1) routeLine = L.polyline(geometry, { color: '#0B5FFF', weight: 5, opacity: 0.85 }).addTo(map);
  }
  function ll(p) { return p ? [p.lat, p.lng] : null; }

  function fit(points, key) {
    if (!map || lastFitKey === key) return;
    lastFitKey = key;
    var pts = points.filter(Boolean);
    if (!pts.length) return;
    var h = $('#sheet').offsetHeight;
    if (pts.length === 1) { map.setView(pts[0], 16); return; }
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 80], paddingBottomRight: [40, h + 30], maxZoom: 17 });
  }

  function drawMap() {
    if (!map) return;
    setMarker('me', ll(pos), icon('mk mk-me', 18));
    if (ride) {
      setMarker('from', ll(ride.from), icon('mk mk-from', 16));
      setMarker('to', ll(ride.to), icon('mk mk-to', 16));
      setMarker('car', ride.driver && ride.driver.loc ? ll(ride.driver.loc) : null, carIcon());
      setRoute(rideRoute);
      var key = 'ride-' + ride.id + '-' + ride.status;
      if (ride.status === 'accepted' || ride.status === 'arrived') fit([ll(ride.driver && ride.driver.loc), ll(ride.from)], key);
      else if (ride.status === 'ongoing') fit([ll(ride.driver && ride.driver.loc), ll(ride.to)], key);
      else fit([ll(ride.from)], key);
      return;
    }
    setMarker('car', null);
    setMarker('from', mode === 'idle' && !dest ? null : ll(origin), icon('mk mk-from', 16));
    setMarker('to', ll(dest), icon('mk mk-to', 16));
    if (mode === 'choose' && estimate) {
      setRoute(estimate.geometry);
      fit([ll(origin), ll(dest)], 'choose-' + origin.lat + dest.lat + dest.lng);
    } else {
      setRoute(null);
    }
  }

  $('#btn-locate').onclick = function () {
    if (pos && map) map.setView([pos.lat, pos.lng], 16);
    else toast('Procurando sua localização…');
  };

  /* ------------------------------------------------------------ */
  /* GPS                                                           */
  /* ------------------------------------------------------------ */
  var gpsStarted = false;
  function startGps() {
    if (gpsStarted) return;
    gpsStarted = true;
    if (!navigator.geolocation) { toast('Este aparelho não tem GPS'); return; }
    navigator.geolocation.watchPosition(function (p) {
      var first = !pos;
      pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (first && map) map.setView([pos.lat, pos.lng], 15);
      if (!originCustom && !ride && (!origin || haversine(origin, pos) > 0.05)) {
        origin = { lat: pos.lat, lng: pos.lng, address: 'Minha localização' };
        if (mode === 'idle') render();
        reverse(pos.lat, pos.lng).then(function (a) {
          if (!originCustom && origin && origin.lat === pos.lat) { origin.address = a; if (mode === 'idle') render(); }
        });
      }
      drawMap();
    }, function (err) {
      if (err && err.code === 1) toast('Ative a permissão de localização para pedir corridas');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  function haversine(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function reverse(lat, lng) {
    return api('GET', '/api/reverse?lat=' + lat + '&lng=' + lng).then(function (r) { return r.address; }, function () { return 'Local no mapa'; });
  }

  /* ------------------------------------------------------------ */
  /* Escolha de origem/destino                                     */
  /* ------------------------------------------------------------ */
  function setPoint(which, lat, lng) {
    var pt = { lat: lat, lng: lng, address: 'Buscando endereço…' };
    if (which === 'origin') { origin = pt; originCustom = true; mode = 'idle'; }
    else { dest = pt; }
    render();
    reverse(lat, lng).then(function (a) {
      pt.address = a;
      if (which === 'dest') loadEstimate(); else render();
    });
  }

  function search() {
    query = ($('#q') || {}).value || query;
    if (query.trim().length < 3) { toast('Digite pelo menos 3 letras'); return; }
    var c = pos || origin || {};
    var qs = '/api/geocode?q=' + encodeURIComponent(query.trim());
    if (c.lat != null) qs += '&lat=' + c.lat + '&lng=' + c.lng;
    busy = true;
    api('GET', qs).then(function (r) {
      results = r.results;
      if (!results.length) toast('Nenhum endereço encontrado. Tente incluir a cidade ou escolha no mapa.');
    }).catch(function (e) { toast(e.message); }).then(function () { busy = false; render(); });
  }

  function loadEstimate() {
    if (!origin || !dest) { toast('Aguarde o GPS encontrar sua localização'); return; }
    busy = true;
    mode = 'choose';
    estimate = null;
    render();
    api('POST', '/api/rides/estimate', { from: origin, to: dest }).then(function (r) {
      estimate = r;
      if (!r.options.some(function (o) { return o.category === category; })) category = r.options[0].category;
    }).catch(function (e) {
      toast(e.message);
      mode = 'idle'; dest = null;
    }).then(function () { busy = false; render(); });
  }

  function requestRide() {
    if (busy || !estimate) return;
    busy = true;
    render();
    api('POST', '/api/rides', { from: origin, to: dest, category: category, payment: payment }).then(function (r) {
      rideRoute = estimate.geometry;
      routeForRide = r.ride.id;
      ride = r.ride;
      mode = 'idle'; results = []; query = '';
    }).catch(function (e) { toast(e.message); }).then(function () { busy = false; render(); });
  }

  /* ------------------------------------------------------------ */
  /* Telas do painel inferior                                      */
  /* ------------------------------------------------------------ */
  function currentView() {
    if (ride) return 'ride';
    if (pendingRating && pendingRating.id !== skipRating) return 'rate';
    return mode;
  }

  function driverCard(d) {
    var ini = esc((d.name || '?').trim().charAt(0).toUpperCase());
    var v = d.vehicle || {};
    return '<div class="driver"><div class="avatar">' + ini + '</div><div class="grow"><b>' + esc(d.name) + '</b>' +
      (d.rating ? ' <span class="muted">★ ' + esc(d.rating) + '</span>' : '') +
      '<div class="muted">' + esc(v.model) + ' · ' + esc(v.color) + '</div><span class="plate">' + esc(v.plate) + '</span></div>' +
      '<a class="call" href="tel:' + esc(String(d.phone || '').replace(/\D/g, '')) + '">Ligar</a></div>';
  }

  function viewIdle() {
    var html = '<div class="grab"></div><h2>Para onde vamos?</h2>' +
      '<div class="place"><span class="dot g"></span><div class="grow"><small>Embarque</small>' + esc(origin ? origin.address : 'Buscando sua localização…') +
      '</div><button class="link" data-act="pickOrigin">Alterar</button></div>' +
      '<form class="search" data-form="search"><input id="q" type="search" placeholder="Digite o destino (rua, bairro, local)" value="' + esc(query) + '" autocomplete="off"><button class="btn" type="submit"' + (busy ? ' disabled' : '') + '>Buscar</button></form>' +
      '<button class="link block" data-act="pickDest">📍 Escolher destino no mapa</button>';
    if (results.length) {
      html += '<ul class="results">' + results.map(function (r, i) { return '<li data-act="pick" data-i="' + i + '">' + esc(r.address) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function viewPick(which) {
    return '<div class="grab"></div><h2>' + (which === 'origin' ? 'Onde você está?' : 'Onde você quer ir?') + '</h2>' +
      '<p class="muted">Toque no mapa para marcar o ' + (which === 'origin' ? 'ponto de embarque' : 'destino') + '.</p>' +
      '<button class="btn ghost" data-act="cancelPick">Cancelar</button>';
  }

  function viewChoose() {
    if (!estimate) {
      return '<div class="grab"></div><div class="status"><div class="spinner"></div><h2>Calculando o preço…</h2></div>';
    }
    var sel = estimate.options.filter(function (o) { return o.category === category; })[0] || estimate.options[0];
    return '<div class="grab"></div>' +
      '<div class="place"><span class="dot g"></span><div class="grow">' + esc(origin.address) + '</div></div>' +
      '<div class="place"><span class="dot k"></span><div class="grow">' + esc(dest.address) + '</div></div>' +
      '<div class="sum"><span>' + Number(estimate.km).toFixed(1).replace('.', ',') + ' km</span><span>~' + estimate.min + ' min</span></div>' +
      '<div class="opts">' + estimate.options.map(function (o) {
        return '<div class="opt' + (o.category === category ? ' sel' : '') + '" data-act="cat" data-cat="' + esc(o.category) + '"><span class="ic">' + (ICON[o.category] || '🚘') + '</span><span class="grow"><b>' + esc(o.label) + '</b></span><b>' + money(o.price) + '</b></div>';
      }).join('') + '</div>' +
      '<select id="pay">' + Object.keys(PAY).map(function (k) { return '<option value="' + k + '"' + (k === payment ? ' selected' : '') + '>Pagamento: ' + esc(PAY[k]) + '</option>'; }).join('') + '</select>' +
      (estimate.approx ? '<p class="note">Valor aproximado: não foi possível traçar a rota exata agora. O preço final é confirmado ao pedir.</p>' : '') +
      '<button class="btn big" data-act="request"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Pedindo…' : 'Pedir ' + esc(sel.label) + ' · ' + money(sel.price)) + '</button>' +
      '<button class="link block" data-act="back">Voltar</button>';
  }

  function viewRide() {
    var r = ride, html = '<div class="grab"></div>';
    if (r.status === 'searching') {
      html += '<div class="status"><div class="spinner"></div><h2>Procurando motorista…</h2></div>' +
        '<div class="place"><span class="dot k"></span><div class="grow">' + esc(r.to.address) + '</div><b>' + money(r.price) + '</b></div>' +
        '<p class="muted">Estamos chamando os motoristas mais próximos. Isso costuma levar menos de 1 minuto.</p>' +
        '<button class="btn danger" data-act="cancelRide">Cancelar pedido</button>';
    } else if (r.status === 'accepted' || r.status === 'arrived') {
      html += '<h2>' + (r.status === 'arrived' ? '🟢 Seu motorista chegou!' : 'Motorista a caminho') + '</h2>' +
        (r.driver ? driverCard(r.driver) : '') +
        (r.pin ? '<div class="pin"><span class="muted">Diga este código ao motorista para iniciar</span><b>' + esc(r.pin) + '</b></div>' : '') +
        '<div class="place"><span class="dot k"></span><div class="grow">' + esc(r.to.address) + '</div><b>' + money(r.price) + '</b></div>' +
        '<p class="muted">Pagamento: ' + esc(PAY[r.payment] || r.payment) + '. Confira a placa antes de entrar.</p>' +
        '<button class="btn danger" data-act="cancelRide">Cancelar corrida</button>';
    } else if (r.status === 'ongoing') {
      html += '<h2>Em viagem</h2>' + (r.driver ? driverCard(r.driver) : '') +
        '<div class="place"><span class="dot k"></span><div class="grow"><small>Destino</small>' + esc(r.to.address) + '</div><b>' + money(r.price) + '</b></div>' +
        '<p class="muted">Pagamento: ' + esc(PAY[r.payment] || r.payment) + '. Pague ao motorista ao chegar.</p>';
    }
    return html;
  }

  function viewRate() {
    var r = pendingRating, name = r.driver ? r.driver.name : 'o motorista';
    var s = '';
    for (var i = 1; i <= 5; i++) s += '<button data-act="star" data-n="' + i + '" class="' + (i <= stars ? 'on' : '') + '" aria-label="' + i + ' estrelas">★</button>';
    return '<div class="grab"></div><div class="center"><h2>Chegamos! 🎉</h2><p class="muted">Corrida de ' + money(r.price) + ' · ' + esc(PAY[r.payment] || r.payment) + '</p>' +
      '<p>Como foi a viagem com <b>' + esc(name) + '</b>?</p><div class="stars">' + s + '</div></div>' +
      '<button class="btn big" data-act="sendRating"' + (stars ? '' : ' disabled') + '>Enviar avaliação</button>' +
      '<button class="link block center" data-act="skipRating">Agora não</button>';
  }

  function render() {
    var v = currentView(), html;
    if (v === 'ride') html = viewRide();
    else if (v === 'rate') html = viewRate();
    else if (v === 'pickOrigin') html = viewPick('origin');
    else if (v === 'pickDest') html = viewPick('dest');
    else if (v === 'choose') html = viewChoose();
    else html = viewIdle();
    $('#sheet').innerHTML = html;
    drawMap();
  }

  /* ---------- eventos do painel ---------- */
  $('#sheet').addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'pickOrigin') { mode = 'pickOrigin'; render(); }
    else if (act === 'pickDest') { mode = 'pickDest'; render(); }
    else if (act === 'cancelPick') { mode = 'idle'; render(); }
    else if (act === 'pick') {
      var r = results[Number(t.getAttribute('data-i'))];
      if (r) { dest = { lat: r.lat, lng: r.lng, address: r.address }; results = []; loadEstimate(); }
    }
    else if (act === 'cat') { category = t.getAttribute('data-cat'); render(); }
    else if (act === 'request') requestRide();
    else if (act === 'back') { mode = 'idle'; dest = null; estimate = null; render(); }
    else if (act === 'cancelRide') {
      if (!confirm('Cancelar esta corrida?')) return;
      api('POST', '/api/rides/' + ride.id + '/cancel').then(function () { ride = null; render(); poll(); }).catch(function (err) { toast(err.message); });
    }
    else if (act === 'star') { stars = Number(t.getAttribute('data-n')); render(); }
    else if (act === 'sendRating') {
      var id = pendingRating.id;
      api('POST', '/api/rides/' + id + '/rate', { stars: stars }).then(function () {
        toast('Obrigado pela avaliação!'); pendingRating = null; stars = 0; render();
      }).catch(function (err) { toast(err.message); });
    }
    else if (act === 'skipRating') { skipRating = pendingRating.id; stars = 0; render(); }
  });
  $('#sheet').addEventListener('submit', function (e) {
    if (e.target.getAttribute('data-form') === 'search') { e.preventDefault(); search(); }
  });
  $('#sheet').addEventListener('input', function (e) { if (e.target.id === 'q') query = e.target.value; });
  $('#sheet').addEventListener('change', function (e) { if (e.target.id === 'pay') payment = e.target.value; });

  /* ---------- menu / histórico ---------- */
  $('#btn-menu').onclick = function () {
    $('#menu-name').textContent = me ? me.name : '';
    $('#menu-phone').textContent = me ? me.phone : '';
    $('#menu').classList.remove('hidden');
    var ul = $('#history');
    ul.innerHTML = '<li class="muted">Carregando…</li>';
    api('GET', '/api/rides/history').then(function (r) {
      if (!r.rides.length) { ul.innerHTML = '<li class="muted">Você ainda não fez corridas.</li>'; return; }
      ul.innerHTML = r.rides.map(function (x) {
        var d = new Date(x.date);
        return '<li class="st-' + esc(x.status) + '"><b>' + esc(d.toLocaleDateString('pt-BR')) + '</b> · ' + esc(STATUS_LABEL[x.status] || x.status) +
          (x.status === 'completed' ? ' · ' + money(x.price) : '') + '<br><span class="muted">' + esc(x.from) + ' → ' + esc(x.to) + '</span></li>';
      }).join('');
    }).catch(function (e) { ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; });
  };
  $('#menu-close').onclick = function () { $('#menu').classList.add('hidden'); };
  $('#menu').addEventListener('click', function (e) { if (e.target === $('#menu')) $('#menu').classList.add('hidden'); });

  /* ------------------------------------------------------------ */
  /* Atualização periódica (polling)                               */
  /* ------------------------------------------------------------ */
  function sigOf(r) {
    if (!r) return 'none';
    return [r.id, r.status, r.pin, r.driver ? r.driver.name : '', r.driver ? r.driver.rating : ''].join('|');
  }

  var polling = false;
  function poll() {
    if (!token || polling) return;
    polling = true;
    api('GET', '/api/passenger/state').then(function (s) {
      var prev = ride;
      ride = s.active;
      pendingRating = s.pending_rating;
      if (s.last_ended && s.last_ended.status === 'no_driver') toast('Não encontramos motorista agora. Tente de novo em instantes.');
      if (prev && !ride && !pendingRating) toast('A corrida foi encerrada.');
      if (ride && routeForRide !== ride.id) {
        routeForRide = ride.id;
        rideRoute = null;
        api('POST', '/api/rides/estimate', { from: ride.from, to: ride.to }).then(function (r) { rideRoute = r.geometry; drawMap(); }, function () {});
      }
      var sig = sigOf(ride) + '#' + (pendingRating ? pendingRating.id : '');
      if (sig !== rideSig) { rideSig = sig; if (ride) { dest = null; estimate = null; mode = 'idle'; } render(); }
      else drawMap(); // só atualiza a posição do carro no mapa
    }).catch(function () { /* mantém o estado; tenta de novo no próximo ciclo */ }).then(function () { polling = false; });
  }

  /* ------------------------------------------------------------ */
  /* Início                                                        */
  /* ------------------------------------------------------------ */
  function startApp() {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    initMap();
    map.invalidateSize();
    startGps();
    render();
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 3000);
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  function boot() {
    if (!L) { document.body.innerHTML = '<p style="padding:24px">Mapa não carregou. Rode "npm install" na pasta do app para copiar o Leaflet para www/lib.</p>'; return; }
    if (!token) { showAuth(); return; }
    api('GET', '/api/me').then(function (r) { me = r.user; startApp(); }, function (e) {
      if (token) { toast(e.message); showAuth(); }
    });
  }
  boot();
})();
