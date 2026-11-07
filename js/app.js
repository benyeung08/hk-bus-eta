/* ============================================================
 * app.js — UI 與狀態（原生 JS，無框架、無追蹤、無廣告）
 * ============================================================ */
(function () {
  'use strict';

  var C = window.HKBUS_CONFIG;
  var api = window.HKBUS.api;
  var data = window.HKBUS.data;

  var I18N = {
    zh: {
      title: '香港巴士到站預報', subtitle: '免費 · 無廣告 · 即時', bus: '巴士', gmb: '小巴',
      placeholder: '搜尋路線號／地點／站名…', nearby: '附近車站', favorites: '收藏', history: '瀏覽紀錄',
      loading: '載入中…', retry: '重試', noResult: '找不到相符路線，試試輸入「1A」「中環」',
      noEta: '暫無預報', arriving: '即將到站', min: '分鐘', updated: '更新於',
      outbound: '去程', inbound: '回程', fare: '收費', map: '路線地圖', refresh: '重新整理',
      addFav: '收藏', removeFav: '已收藏', stops: '沿途車站', noStops: '暫時未能讀取站序資料',
      locate: '定位附近車站', locating: '正在定位…', locateFail: '無法取得位置，請檢查瀏覽器定位權限',
      indexReady: '路線資料已載入', indexLive: '精簡模式（直接讀取政府 API）',
      indexUpdated: '路線資料已自動更新', indexFail: '資料連線失敗',
      stopBoard: '站牌預報', back: '返回',
      kmb: '九巴', ctb: '城巴', gmbLabel: '專線小巴', nlb: '嶼巴', other: '其他',
      dataSource: '資料來源：運輸署資料一站通及各營辦商開放 API',
      disclaimer: '預報只供參考，實際班次受交通及營運情況影響。',
      scheduled: '預定班次', noIndex: '無法載入路線資料', favEmpty: '尚未收藏，點路線頁的 ☆ 即可加入',
      histEmpty: '暫無瀏覽紀錄', nearEmpty: '附近沒有符合的車站', nearest: '距離',
      all: '全部', themeLight: '淺色', themeDark: '深色', clear: '清除', copied: '已複製',
      mapLoading: '載入地圖…', mapFail: '地圖載入失敗', openMap: '在地圖查看'
    },
    en: {
      title: 'HK Bus ETA', subtitle: 'Free · Ad-free · Live', bus: 'Bus', gmb: 'Minibus',
      placeholder: 'Search route / place / stop…', nearby: 'Nearby stops', favorites: 'Saved', history: 'Recent',
      loading: 'Loading…', retry: 'Retry', noResult: 'No matching route. Try "1A" or "Central"',
      noEta: 'No ETA', arriving: 'Arriving', min: 'min', updated: 'Updated',
      outbound: 'Outbound', inbound: 'Inbound', fare: 'Fare', map: 'Route map', refresh: 'Refresh',
      addFav: 'Save', removeFav: 'Saved', stops: 'Stops', noStops: 'Stop list unavailable',
      locate: 'Find nearby stops', locating: 'Locating…', locateFail: 'Location unavailable. Check browser permission.',
      indexReady: 'Route data loaded', indexLive: 'Lite mode (direct government APIs)',
      indexUpdated: 'Route data updated', indexFail: 'Connection failed',
      stopBoard: 'Stop board', back: 'Back',
      kmb: 'KMB', ctb: 'Citybus', gmbLabel: 'GMB', nlb: 'NLB', other: 'Other',
      dataSource: 'Data: DATA.GOV.HK and operator open APIs',
      disclaimer: 'Estimates are indicative only; actual service may vary.',
      scheduled: 'Scheduled', noIndex: 'Route data unavailable', favEmpty: 'Nothing saved yet — tap ☆ on a route',
      histEmpty: 'No recent routes', nearEmpty: 'No matching stops nearby', nearest: 'Away',
      all: 'All', themeLight: 'Light', themeDark: 'Dark', clear: 'Clear', copied: 'Copied',
      mapLoading: 'Loading map…', mapFail: 'Map failed to load', openMap: 'View on map'
    }
  };

  var CO_LABEL = { kmb: '九', ctb: '城', gmb: '綠', nlb: '嶼', lrtfeeder: '港', mtr: '鐵' };
  var CO_CLASS = { kmb: 'kmb', ctb: 'ctb', gmb: 'gmb', nlb: 'nlb', lrtfeeder: 'other', mtr: 'other' };

  var state = {
    index: null, mode: 'bus', lang: 'zh', theme: 'auto', view: 'home',
    routeKey: null, stopId: null, query: '', nearby: null, observer: null,
    etaRows: [], lastUpdated: null, loadError: null
  };

  var $ = function (s) { return document.querySelector(s); };
  var view = function () { return $('#view'); };
  function t(k) { return (I18N[state.lang] || I18N.zh)[k] || k; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function coLabel(co) { return state.lang === 'en' ? (CO_LABEL[co] ? co.toUpperCase() : co) : (CO_LABEL[co] || co); }
  function coBadge(co) {
    return '<span class="co co-' + (CO_CLASS[co] || 'other') + '" title="' + esc(coLabel(co)) + '">' + esc(coLabel(co)) + '</span>';
  }
  function routeTitle(r) {
    var o = state.lang === 'en' ? data.en(r.orig) : data.zh(r.orig);
    var d = state.lang === 'en' ? data.en(r.dest) : data.zh(r.dest);
    return (o || '—') + ' → ' + (d || '—');
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString(state.lang === 'en' ? 'en-GB' : 'zh-Hant-HK',
        { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong' });
    } catch (e) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  }
  function minsUntil(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.round((d.getTime() - Date.now()) / 60000);
  }

  /* ---------------- 本地儲存 ---------------- */
  function readLS(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function favs() { return readLS('hkbus_fav_v1', []); }
  function isFav(type, id) {
    return favs().some(function (x) { return x.type === type && x.id === id; });
  }
  function toggleFav(type, id, name) {
    var list = favs();
    var i = list.findIndex(function (x) { return x.type === type && x.id === id; });
    if (i >= 0) list.splice(i, 1); else list.unshift({ type: type, id: id, name: name || id });
    writeLS('hkbus_fav_v1', list.slice(0, 100));
    return i < 0;
  }
  function history() { return readLS('hkbus_hist_v1', []); }
  function pushHistory(r) {
    var list = history().filter(function (k) { return k !== r.key; });
    list.unshift(r.key);
    writeLS('hkbus_hist_v1', list.slice(0, 20));
  }

  /* ---------------- ETA 顯示 ---------------- */
  function etaHtml(list) {
    if (!list || !list.length) return '<span class="eta-none">' + esc(t('noEta')) + '</span>';
    return list.slice(0, 3).map(function (x) {
      var m = x.eta ? minsUntil(x.eta) : null;
      var label, cls = '';
      if (m === null) label = x.remark || '—';
      else if (m < -1) label = fmtTime(x.eta);
      else if (m <= 1) { label = t('arriving'); cls = ' soon'; }
      else if (m > 90) label = fmtTime(x.eta);
      else label = m + ' ' + t('min');
      var remark = x.remark ? '<span class="remark">' + esc(x.remark) + '</span>' : '';
      var time = x.eta ? '<small>' + esc(fmtTime(x.eta)) + '</small>' : '';
      return '<div class="eta-item' + cls + '">' + coBadge(x.co) +
        '<b>' + esc(label) + '</b>' + time + remark + '</div>';
    }).join('');
  }

  function touchUpdated() {
    state.lastUpdated = new Date();
    var el = $('#statusLine');
    if (el) el.textContent = t('updated') + ' ' + fmtTime(state.lastUpdated.toISOString());
  }

  var statusTimer = null;
  function flashStatus(msg, restore) {
    var el = $('#statusLine');
    if (el) el.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      var e2 = $('#statusLine');
      if (e2) e2.textContent = restore;
    }, 6000);
  }

  /* ---------------- 版面骨架 ---------------- */
  function card(html, cls) { return '<div class="card ' + (cls || '') + '">' + html + '</div>'; }
  function errorCard(msg) {
    return card('<div class="empty">⚠️ <p>' + esc(msg) + '</p>' +
      '<button class="btn" onclick="location.reload()">' + esc(t('retry')) + '</button></div>');
  }

  function routeCard(r) {
    var cos = (r.co || []).map(coBadge).join('');
    var fare = (r.fares && r.fares.length) ? '<span class="fare">$' + esc(r.fares[r.fares.length - 1]) + '</span>' : '';
    return '<a class="card route-card" href="#/route/' + encodeURIComponent(r.key) + '">' +
      '<div class="route-no">' + esc(r.route) + '</div>' +
      '<div class="route-meta"><div class="route-dest">' + esc(routeTitle(r)) + '</div>' +
      '<div class="route-sub">' + cos + fare + '</div></div>' +
      '<span class="chev">›</span></a>';
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('#searchInput').value = '';
    state.query = '';
    if (state.view === 'home' || state.view === 'search') renderHome();
  }

  /* ---------------- 首頁／收藏／紀錄 ---------------- */
  function renderHome() {
    state.view = 'home';
    var fav = favs(), hist = history(), idx = state.index;
    var status = idx ? (idx.live ? t('indexLive') : t('indexReady')) : t('loading');
    var html = '<div class="hero">' +
      '<div class="hero-badge">' + esc(status) + '</div>' +
      '<p>' + esc(t('subtitle')) + '</p></div>';

    html += '<h2 class="section-title">⭐ ' + esc(t('favorites')) + '</h2>';
    var favRoutes = fav.filter(function (x) { return x.type === 'route' && idx && idx.byKey[x.id]; });
    var favStops = fav.filter(function (x) { return x.type === 'stop'; });
    if (!favRoutes.length && !favStops.length) {
      html += card('<div class="empty">' + esc(t('favEmpty')) + '</div>');
    } else {
      html += favRoutes.map(function (x) { return routeCard(idx.byKey[x.id]); }).join('');
      html += favStops.map(function (x) {
        return '<a class="card route-card" href="#/stop/' + encodeURIComponent(x.id) + '">' +
          '<div class="route-no stop-ico">🚏</div><div class="route-meta">' +
          '<div class="route-dest">' + esc(x.name) + '</div>' +
          '<div class="route-sub">' + esc(t('stopBoard')) + '</div></div><span class="chev">›</span></a>';
      }).join('');
    }

    html += '<h2 class="section-title">🕘 ' + esc(t('history')) + '</h2>';
    var hs = hist.filter(function (k) { return idx && idx.byKey[k]; }).slice(0, 8);
    html += hs.length ? hs.map(function (k) { return routeCard(idx.byKey[k]); }).join('')
      : card('<div class="empty">' + esc(t('histEmpty')) + '</div>');

    html += '<div class="footnote">' + esc(t('dataSource')) + '<br>' + esc(t('disclaimer')) + '</div>';
    view().innerHTML = html;
  }

  function renderFav() {
    state.view = 'fav';
    var fav = favs(), idx = state.index;
    var html = '<div class="page-head"><button class="btn ghost" onclick="history.back()">‹ ' + esc(t('back')) + '</button>' +
      '<h2>⭐ ' + esc(t('favorites')) + '</h2></div>';
    var items = fav.map(function (x) {
      if (x.type === 'route' && idx && idx.byKey[x.id]) return routeCard(idx.byKey[x.id]);
      if (x.type === 'stop') return '<a class="card route-card" href="#/stop/' + encodeURIComponent(x.id) + '">' +
        '<div class="route-no stop-ico">🚏</div><div class="route-meta"><div class="route-dest">' +
        esc(x.name) + '</div><div class="route-sub">' + esc(t('stopBoard')) + '</div></div><span class="chev">›</span></a>';
      return '';
    }).join('');
    view().innerHTML = html + (items || card('<div class="empty">' + esc(t('favEmpty')) + '</div>'));
  }

  function renderHistory() {
    state.view = 'history';
    var idx = state.index, hist = history().filter(function (k) { return idx && idx.byKey[k]; });
    var html = '<div class="page-head"><button class="btn ghost" onclick="history.back()">‹ ' + esc(t('back')) + '</button>' +
      '<h2>🕘 ' + esc(t('history')) + '</h2></div>';
    view().innerHTML = html + (hist.length ? hist.map(function (k) { return routeCard(idx.byKey[k]); }).join('')
      : card('<div class="empty">' + esc(t('histEmpty')) + '</div>'));
  }

  /* ---------------- 搜尋結果 ---------------- */
  function renderSearch(q) {
    state.query = q;
    state.view = 'search';
    if (!q) return renderHome();
    var list = data.search(state.index, q, state.mode);
    var html = '<div class="result-head">' + esc(q) + ' · ' + list.length + '</div>';
    view().innerHTML = html + (list.length ? list.map(routeCard).join('')
      : card('<div class="empty">' + esc(t('noResult')) + '</div>'));
  }

  /* ---------------- 路線頁 ---------------- */
  function primaryCo(r) {
    var best = null, n = 0;
    (r.co || []).forEach(function (co) {
      var len = (r.stops[co] || []).length;
      if (len > n) { n = len; best = co; }
    });
    return best || (r.co || [])[0];
  }

  async function renderRoute(key) {
    var idx = state.index, r = idx && idx.byKey[key];
    if (!r) { view().innerHTML = errorCard(t('noResult')); return; }
    state.view = 'route'; state.routeKey = key;
    pushHistory(r);

    view().innerHTML =
      '<div class="page-head"><button class="btn ghost" onclick="history.back()">‹ ' + esc(t('back')) + '</button>' +
      '<div class="head-actions">' +
      '<button class="btn ghost" id="favBtn2">' + (isFav('route', key) ? '★ ' + esc(t('removeFav')) : '☆ ' + esc(t('addFav'))) + '</button>' +
      '<button class="btn ghost" id="refreshBtn">↻ ' + esc(t('refresh')) + '</button></div></div>' +
      card('<div class="route-hero"><div class="route-no big">' + esc(r.route) + '</div>' +
        '<div><div class="route-dest">' + esc(routeTitle(r)) + '</div>' +
        '<div class="route-sub">' + (r.co || []).map(coBadge).join('') +
        '<span class="chip">' + esc(t((r.bound[primaryCo(r)] || 'O') === 'I' ? 'inbound' : 'outbound')) + '</span></div></div></div>' +
        ((r.fares && r.fares.length) ? '<div class="fare-line">💰 ' + esc(t('fare')) + ' $' +
          esc(r.fares[0]) + ' – $' + esc(r.fares[r.fares.length - 1]) + '</div>' : ''), 'hero-card') +
      '<div class="list-head"><h2>' + esc(t('stops')) + '</h2>' +
      '<button class="btn ghost small" id="mapBtn">🗺 ' + esc(t('map')) + '</button></div>' +
      '<div id="stopRows"><div class="loading">' + esc(t('loading')) + '</div></div>';

    $('#favBtn2').onclick = function () {
      toggleFav('route', key, r.route + ' ' + routeTitle(r));
      renderRoute(key);
    };
    $('#refreshBtn').onclick = function () { refreshVisibleEta(true); };
    $('#mapBtn').onclick = function () { showRouteMap(r); };

    await data.ensureStops(idx, r);
    var co = primaryCo(r), ids = r.stops[co] || [];
    if (!ids.length) { $('#stopRows').innerHTML = card('<div class="empty">' + esc(t('noStops')) + '</div>'); return; }

    $('#stopRows').innerHTML = ids.map(function (sid, seq) {
      return '<div class="stop-row" data-seq="' + seq + '" data-stop="' + esc(sid) + '">' +
        '<div class="stop-dot"><span></span></div>' +
        '<div class="stop-body"><div class="stop-name">' + esc(data.stopName(idx, sid, state.lang)) + '</div>' +
        '<div class="eta-slot"><span class="eta-none">' + esc(t('loading')) + '</span></div></div></div>';
    }).join('');

    state.etaRows = Array.prototype.slice.call(document.querySelectorAll('.stop-row'));
    setupObserver(r);
  }

  function setupObserver(r) {
    if (state.observer) state.observer.disconnect();
    var pending = [];
    state.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var row = e.target;
        if (row.dataset.busy) return;
        row.dataset.busy = '1';
        pending.push(row);
      });
      if (!pending.length) return;
      var batch = pending.splice(0);
      api.mapLimit(batch, C.ETA_CONCURRENCY, async function (row) {
        var seq = Number(row.dataset.seq);
        var list = await api.etaForStop(r, seq);
        var slot = row.querySelector('.eta-slot');
        if (slot) slot.innerHTML = etaHtml(list);
        row.dataset.busy = '';
        row.dataset.loaded = '1';
        touchUpdated();
      });
    }, { rootMargin: '250px 0px' });
    state.etaRows.forEach(function (row) { state.observer.observe(row); });
  }

  function refreshVisibleEta(force) {
    if (state.view !== 'route' || !state.index) return;
    var r = state.index.byKey[state.routeKey];
    if (!r) return;
    var rows = state.etaRows.filter(function (row) {
      if (force) return row.dataset.loaded === '1';
      var rect = row.getBoundingClientRect();
      return rect.top < window.innerHeight + 200 && rect.bottom > -200;
    });
    api.mapLimit(rows, C.ETA_CONCURRENCY, async function (row) {
      var seq = Number(row.dataset.seq);
      var list = await api.etaForStop(r, seq);
      var slot = row.querySelector('.eta-slot');
      if (slot) slot.innerHTML = etaHtml(list);
    }).then(touchUpdated);
  }

  /* ---------------- 附近車站 ---------------- */
  function renderNearby() {
    state.view = 'nearby';
    view().innerHTML =
      '<div class="page-head"><button class="btn ghost" onclick="history.back()">‹ ' + esc(t('back')) + '</button>' +
      '<h2>📍 ' + esc(t('nearby')) + '</h2></div>' +
      '<button class="btn primary wide" id="locateBtn">◎ ' + esc(t('locate')) + '</button>' +
      '<div id="nearbyList"><div class="loading">' + esc(t('loading')) + '</div></div>';
    $('#locateBtn').onclick = locate;
    locate();
  }

  function locate() {
    var box = $('#nearbyList');
    if (!box) return;
    box.innerHTML = '<div class="loading">' + esc(t('locating')) + '</div>';
    var done = function (lat, lng) {
      state.nearby = data.nearby(state.index, lat, lng, state.mode);
      var list = state.nearby || [];
      if (!list.length) { box.innerHTML = card('<div class="empty">' + esc(t('nearEmpty')) + '</div>'); return; }
      box.innerHTML = '<button class="btn ghost wide small" id="nearMapBtn">🗺 ' + esc(t('openMap')) + '</button>' +
        list.map(function (s) {
          return '<a class="card stop-card" href="#/stop/' + encodeURIComponent(s.id) + '">' +
            '<div class="stop-card-top"><b>' + esc(s.name) + '</b><span class="dist">' +
            esc(t('nearest')) + ' ' + s.distance + ' m</span></div>' +
            '<div class="route-sub">' + s.companies.map(coBadge).join('') + '</div></a>';
        }).join('');
      var mb = $('#nearMapBtn');
      if (mb) mb.onclick = function () { showNearbyMap(lat, lng, list); };
    };
    if (!navigator.geolocation) return done(C.MAP_CENTER[0], C.MAP_CENTER[1]);
    navigator.geolocation.getCurrentPosition(
      function (p) { done(p.coords.latitude, p.coords.longitude); },
      function () { box.innerHTML = card('<div class="empty">' + esc(t('locateFail')) + '</div>'); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /* ---------------- 站牌頁 ---------------- */
  async function renderStop(id) {
    var idx = state.index;
    state.view = 'stop'; state.stopId = id;
    var name = data.stopName(idx, id, state.lang);
    var hits = (idx && idx.stopIndex[id]) || [];
    var companies = [];
    hits.forEach(function (h) { if (companies.indexOf(h.co) < 0) companies.push(h.co); });
    if (!companies.length) {
      var near = (state.nearby || []).filter(function (s) { return s.id === id; })[0];
      companies = near && near.companies.length ? near.companies :
        (state.mode === 'gmb' ? ['gmb'] : ['kmb', 'ctb']);
    }

    view().innerHTML =
      '<div class="page-head"><button class="btn ghost" onclick="history.back()">‹ ' + esc(t('back')) + '</button>' +
      '<div class="head-actions"><button class="btn ghost" id="favStopBtn">' +
      (isFav('stop', id) ? '★ ' + esc(t('removeFav')) : '☆ ' + esc(t('addFav'))) + '</button>' +
      '<button class="btn ghost" id="stopRefresh">↻ ' + esc(t('refresh')) + '</button></div></div>' +
      card('<div class="route-hero"><div class="route-no big stop-ico">🚏</div>' +
        '<div><div class="route-dest">' + esc(name) + '</div>' +
        '<div class="route-sub">' + companies.map(coBadge).join('') + '</div></div></div>', 'hero-card') +
      '<h2 class="section-title">' + esc(t('stopBoard')) + '</h2>' +
      '<div id="board"><div class="loading">' + esc(t('loading')) + '</div></div>';

    $('#favStopBtn').onclick = function () { toggleFav('stop', id, name); renderStop(id); };
    $('#stopRefresh').onclick = function () { renderStop(id); };
    await loadBoard(id, companies, idx, hits);
  }

  async function loadBoard(id, companies, idx, hits) {
    var board = $('#board');
    if (!board) return;
    var rows = await api.fetchStopBoard(id, companies, idx);
    // 嶼巴沒有整站 API，改由站序索引逐線查詢
    var nlbKeys = hits.filter(function (h) { return h.co === 'nlb'; }).slice(0, C.MAX_STOP_BOARD_ROUTES);
    if (nlbKeys.length) {
      var extra = await api.mapLimit(nlbKeys, 3, async function (h) {
        var r = idx.byKey[h.key];
        if (!r) return [];
        var list = await api.etaForStop(r, h.seq);
        return list.map(function (x) {
          return { route: r.route, co: 'nlb', dest: x.dest, eta: x.eta, remark: x.remark, seq: x.seq, dir: h.bound };
        });
      });
      rows = rows.concat(extra.reduce(function (a, b) { return a.concat(b || []); }, []));
      rows.sort(function (a, b) {
        return (a.eta ? new Date(a.eta).getTime() : Infinity) - (b.eta ? new Date(b.eta).getTime() : Infinity);
      });
    }
    if (!rows.length) { board.innerHTML = card('<div class="empty">' + esc(t('noEta')) + '</div>'); touchUpdated(); return; }
    var groups = {};
    rows.forEach(function (x) {
      var k = x.co + '|' + x.route + '|' + (x.dir || '');
      if (!groups[k]) groups[k] = { co: x.co, route: x.route, dest: x.dest, dir: x.dir, etas: [] };
      groups[k].etas.push(x);
    });
    board.innerHTML = Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.etas.sort(function (a, b) { return (Number(a.seq) || 9) - (Number(b.seq) || 9); });
      return '<div class="board-row"><div class="board-route">' + coBadge(g.co) +
        '<b>' + esc(g.route) + '</b><span class="board-dest">' + esc(g.dest || '') + '</span></div>' +
        '<div class="board-etas">' + etaHtml(g.etas) + '</div></div>';
    }).join('');
    touchUpdated();
  }

  /* ---------------- 地圖（Leaflet 按需載入） ---------------- */
  var leafletPromise = null;
  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('leaflet')); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  function openMapModal() {
    var m = $('#mapModal');
    m.classList.remove('hidden');
    if (!m.dataset.init) {
      m.dataset.init = '1';
      m.innerHTML = '<div class="map-bar"><b id="mapTitle">🗺</b><button class="btn ghost" id="mapClose">✕</button></div>' +
        '<div id="map"></div>';
      $('#mapClose').onclick = function () { m.classList.add('hidden'); };
    }
    return m;
  }

  async function drawMap(points, poly, center, zoom) {
    var modal = openMapModal();
    $('#mapTitle').textContent = '🗺 ' + t('map');
    try { await ensureLeaflet(); } catch (e) {
      $('#map').innerHTML = '<div class="empty">' + esc(t('mapFail')) + '</div>'; return;
    }
    setTimeout(function () {
      if (!window.L) return;
      if (modal._leafletMap) { modal._leafletMap.remove(); modal._leafletMap = null; }
      var map = window.L.map('map');
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
      }).addTo(map);
      var group = window.L.featureGroup();
      points.forEach(function (p) {
        if (!isFinite(p.lat) || !isFinite(p.lng)) return;
        window.L.marker([p.lat, p.lng]).addTo(group).bindPopup(esc(p.name || ''));
      });
      if (poly && poly.length > 1) window.L.polyline(poly, { color: '#e8483f', weight: 4, opacity: .75 }).addTo(group);
      group.addTo(map);
      if (poly && poly.length > 1) map.fitBounds(group.getBounds().pad(0.15));
      else map.setView(center || C.MAP_CENTER, zoom || C.MAP_ZOOM);
      setTimeout(function () { map.invalidateSize(); }, 150);
      modal._leafletMap = map;
    }, 60);
  }

  function showRouteMap(r) {
    var co = primaryCo(r), ids = r.stops[co] || [];
    var pts = ids.map(function (sid, i) {
      var loc = data.stopLocation(state.index, sid);
      return { lat: loc.lat, lng: loc.lng, name: (i + 1) + '. ' + data.stopName(state.index, sid, state.lang) };
    }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng) && p.lat; });
    drawMap(pts, pts.map(function (p) { return [p.lat, p.lng]; }), C.MAP_CENTER, C.MAP_ZOOM);
  }

  function showNearbyMap(lat, lng, list) {
    var pts = [{ lat: lat, lng: lng, name: t('locate') }].concat(list.map(function (s) {
      return { lat: s.lat, lng: s.lng, name: s.name + ' · ' + s.distance + 'm' };
    }));
    drawMap(pts, null, [lat, lng], 16);
  }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var p = h.split('/');
    try {
      switch (p[0]) {
        case 'route': return renderRoute(decodeURIComponent(p.slice(1).join('/')));
        case 'stop': return renderStop(decodeURIComponent(p.slice(1).join('/')));
        case 'nearby': return renderNearby();
        case 'fav': return renderFav();
        case 'history': return renderHistory();
        default: return renderHome();
      }
    } catch (e) {
      view().innerHTML = errorCard(t('indexFail'));
    }
  }

  /* ---------------- 啟動 ---------------- */
  function applyI18n() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-Hant';
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    $('#searchInput').placeholder = t('placeholder');
    $('#langBtn').textContent = state.lang === 'zh' ? 'EN' : '中';
    $('#nearbyBtn').textContent = '📍 ' + t('nearby');
    $('#favBtn').textContent = '⭐ ' + t('favorites');
    $('#histBtn').textContent = '🕘 ' + t('history');
    $('[data-mode="bus"]').textContent = '🚌 ' + t('bus');
    $('[data-mode="gmb"]').textContent = '🚐 ' + t('gmb');
    $('#footerText').textContent = t('dataSource') + ' · ' + t('disclaimer');
  }

  function applyTheme() {
    var dark = state.theme === 'dark' ||
      (state.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#themeBtn').textContent = dark ? '☀️' : '🌙';
  }

  function bindUI() {
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.mode); };
    });
    $('#langBtn').onclick = function () {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      writeLS('hkbus_lang_v1', state.lang);
      applyI18n(); parseHash();
    };
    $('#themeBtn').onclick = function () {
      state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      writeLS('hkbus_theme_v1', state.theme);
      applyTheme();
    };
    $('#nearbyBtn').onclick = function () { location.hash = '#/nearby'; };
    $('#favBtn').onclick = function () { location.hash = '#/fav'; };
    $('#histBtn').onclick = function () { location.hash = '#/history'; };
    var timer = null;
    $('#searchInput').addEventListener('input', function (e) {
      clearTimeout(timer);
      var q = e.target.value.trim();
      timer = setTimeout(function () {
        // replaceState 不會觸發 hashchange，避免剛渲染的結果被首頁覆蓋
        if (location.hash && location.hash !== '#/' && location.hash !== '#') {
          window.history.replaceState(null, '', location.pathname + location.search + '#/');
        }
        renderSearch(q);
      }, 200);
    });
    $('#clearSearch').onclick = function () {
      $('#searchInput').value = ''; renderSearch(''); $('#searchInput').focus();
    };
    window.addEventListener('hashchange', parseHash);
  }

  async function boot() {
    state.lang = readLS('hkbus_lang_v1', 'zh');
    state.theme = readLS('hkbus_theme_v1', 'auto');
    applyI18n(); applyTheme(); bindUI();
    view().innerHTML = '<div class="loading big-loading">🚌<br>' + esc(t('loading')) + '</div>';
    try {
      state.index = await data.load();
      $('#statusLine').textContent = state.index.live ? t('indexLive') : t('indexReady');
      state.loadError = null;
    } catch (e) {
      state.loadError = t('noIndex');
      view().innerHTML = errorCard(t('noIndex'));
      $('#statusLine').textContent = t('indexFail');
      return;
    }
    parseHash();

    // 版本檔一變就自動換新索引並重繪，使用者不必重新整理頁面
    data.startVersionWatcher(function (res) {
      if (state.observer) { state.observer.disconnect(); state.observer = null; }
      state.index = res.index;
      state.nearby = null;
      if (state.view === 'search' && state.query) renderSearch(state.query);
      else parseHash();
      flashStatus('🔄 ' + t('indexUpdated') + ' · v' + res.version.slice(0, 8),
        state.index.live ? t('indexLive') : t('indexReady'));
    });

    setInterval(function () {
      if (state.view === 'route') refreshVisibleEta(false);
      else if (state.view === 'stop' && state.index) {
        var hits = state.index.stopIndex[state.stopId] || [];
        var cos = [];
        hits.forEach(function (h) { if (cos.indexOf(h.co) < 0) cos.push(h.co); });
        if (!cos.length) {
          var near = (state.nearby || []).filter(function (s) { return s.id === state.stopId; })[0];
          cos = near && near.companies.length ? near.companies :
            (state.mode === 'gmb' ? ['gmb'] : ['kmb', 'ctb']);
        }
        loadBoard(state.stopId, cos, state.index, hits);
      }
    }, C.REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
