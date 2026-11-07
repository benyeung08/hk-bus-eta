/* ============================================================
 * data.js — 路線／車站索引、搜尋、附近車站、自動更新
 * 索引（路線、站序、站名、座標、收費）由 GitHub Actions 每日兩次自動產生；
 * 版本檔的內容雜湊一變，前端會自動換新索引，不用重新整理頁面。
 * 即時到站一律由 api.js 直接向政府 API 查詢。
 * 所有索引來源都失敗時，會自動改用「政府 API 精簡模式」。
 * ============================================================ */
(function () {
  'use strict';

  var C = window.HKBUS_CONFIG;
  var api = window.HKBUS.api;
  var E = api.endpoints;

  var CACHE_NAME = 'hkbus-index-v2';
  var VERSION_KEY = 'hkbus_index_version_v2';

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ''); }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }
  function zh(o) { return (o && (o.zh || o.tc || o.name_tc)) || ''; }
  function en(o) { return (o && (o.en || o.name_en)) || ''; }

  function readVersion() {
    try { return localStorage.getItem(VERSION_KEY) || ''; } catch (e) { return ''; }
  }
  function writeVersion(v) {
    try { if (v) localStorage.setItem(VERSION_KEY, v); } catch (e) {}
  }

  /* ---------- 索引／版本檔讀取（不走 ETA 代理，自帶 timeout） ---------- */
  async function fetchText(url, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || 20000);
    try {
      var res = await fetch(url, {
        cache: 'no-store', signal: ctrl.signal,
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally { clearTimeout(timer); }
  }

  async function plainJSON(url, timeout) {
    return JSON.parse(await fetchText(url, timeout));
  }

  /** 版本檔不存在／標記 unavailable／連線失敗，一律視為「不確定」，不觸發重載 */
  async function fetchVersion() {
    if (!C.VERSIONS_URL) return null;
    try {
      var meta = await plainJSON(C.VERSIONS_URL, 8000);
      if (meta && meta.status === 'ok' && meta.version) return String(meta.version);
    } catch (e) {}
    return null;
  }

  /** 讓舊索引快取立刻失效 */
  async function invalidateIndexCache() {
    if (!('caches' in window)) return;
    try {
      var cache = await caches.open(CACHE_NAME);
      await Promise.all((C.INDEX_URLS || []).map(function (u) { return cache.delete(u); }));
    } catch (e) {}
  }

  /** Cache Storage 可放大檔，避開 localStorage 5MB 限制 */
  async function cachedJSON(url, timeout) {
    if ('caches' in window) {
      try {
        var cache = await caches.open(CACHE_NAME);
        var hit = await cache.match(url);
        if (hit) {
          var age = Date.now() - Number(hit.headers.get('x-cached-at') || 0);
          if (age >= 0 && age < C.INDEX_CACHE_MS) return JSON.parse(await hit.text());
        }
        var text = await fetchText(url, timeout);
        var json = JSON.parse(text);
        await cache.put(url, new Response(text, {
          headers: { 'Content-Type': 'application/json', 'x-cached-at': String(Date.now()) }
        }));
        return json;
      } catch (e) { /* 退回直接讀 */ }
    }
    return await plainJSON(url, timeout);
  }

  function routeText(index, r) {
    var parts = [r.route, zh(r.orig), en(r.orig), zh(r.dest), en(r.dest)];
    (r.co || []).forEach(function (co) {
      (r.stops[co] || []).forEach(function (sid) {
        var s = index.stopList[sid];
        if (s) parts.push(zh(s.name), en(s.name));
      });
    });
    return norm(parts.join(''));
  }

  function buildIndex(json, live) {
    var routeList = json.routeList || {};
    var stopList = json.stopList || {};
    var routes = [], stopIndex = {}, byGtfsId = {};

    Object.keys(routeList).forEach(function (key) {
      var e = routeList[key];
      if (!e || !e.route) return;
      var r = Object.assign({}, e, {
        key: key,
        co: e.co || [],
        stops: e.stops || {},
        bound: e.bound || {},
        orig: e.orig || {},
        dest: e.dest || {}
      });
      routes.push(r);
      if (r.gtfsId) byGtfsId[String(r.gtfsId)] = { route: r.route, dest: zh(r.dest) };
      r.co.forEach(function (co) {
        (r.stops[co] || []).forEach(function (sid, seq) {
          if (!stopIndex[sid]) stopIndex[sid] = [];
          stopIndex[sid].push({ key: key, co: co, seq: seq, bound: r.bound[co] || 'O' });
        });
      });
    });

    var index = {
      routes: routes,
      stopList: stopList,
      stopIndex: stopIndex,
      byGtfsId: byGtfsId,
      byKey: {},
      live: !!live,
      stopNames: json.stopNames || {},
      loadedAt: Date.now()
    };
    routes.forEach(function (r) {
      index.byKey[r.key] = r;
      r._q = routeText(index, r);
    });
    return index;
  }

  /* ---------- 政府 API 精簡模式 ---------- */
  function liveRoute(key, route, co, extra) {
    return Object.assign({
      key: key, route: route, co: co, stops: {}, bound: {}, orig: { zh: '', en: '' },
      dest: { zh: '', en: '' }, serviceType: '1', fares: null, freq: null, jt: null
    }, extra || {});
  }

  async function buildLiveIndex() {
    var routes = [], stopList = {}, stopNames = {};
    var jobs = [
      // 九巴／龍運：路線清單 + 全港車站（含座標與站名）
      (async function () {
        var d = (await api.getJSON(E.KMB + '/route/', 20000)).data || [];
        var stops = [];
        try { stops = (await api.getJSON(E.KMB + '/stop', 20000)).data || []; } catch (e) {}
        stops.forEach(function (s) {
          stopList[s.stop] = { location: { lat: Number(s.lat), lng: Number(s.long) },
            name: { zh: s.name_tc, en: s.name_en } };
          stopNames[s.stop] = { zh: s.name_tc, en: s.name_en, lat: Number(s.lat), lng: Number(s.long) };
        });
        d.forEach(function (e) {
          var bound = String(e.bound || '1') === '0' ? 'O' : (e.bound === 'I' ? 'I' : 'O');
          var st = String(e.service_type || '1');
          var r = liveRoute('KMB+' + e.route + '+' + bound + '+' + st, e.route, ['kmb'], {
            serviceType: st, orig: { zh: e.orig_tc, en: e.orig_en },
            dest: { zh: e.dest_tc, en: e.dest_en }
          });
          r.bound.kmb = bound;
          r._live = { type: 'kmb', bound: bound, serviceType: st };
          routes.push(r);
        });
      })(),
      // 城巴
      (async function () {
        var raw = (await api.getJSON(E.CTB + '/route/ctb', 20000)).data || [];
        var d = Array.isArray(raw) ? raw : (raw.routes || Object.keys(raw).map(function (k) { return raw[k]; }));
        d.forEach(function (e) {
          var r = liveRoute('CTB+' + e.route, String(e.route), ['ctb'], {
            orig: { zh: e.orig_tc, en: e.orig_en }, dest: { zh: e.dest_tc, en: e.dest_en }
          });
          r.bound.ctb = 'O';
          r._live = { type: 'ctb' };
          routes.push(r);
        });
      })(),
      // 專線小巴（只先載路線號，點入時才查 route_id）
      (async function () {
        var d = (await api.getJSON(E.GMB + '/route', 20000)).data || {};
        var byRegion = d.routes || {};
        Object.keys(byRegion).forEach(function (region) {
          (byRegion[region] || []).forEach(function (code) {
            var r = liveRoute('GMB+' + region + '+' + code, String(code), ['gmb'], {});
            r.bound.gmb = 'O';
            r._live = { type: 'gmb', region: region };
            routes.push(r);
          });
        });
      })(),
      // 嶼巴
      (async function () {
        var d = (await api.getJSON(E.NLB + '/route.php?action=list', 20000)).routes || [];
        d.forEach(function (e) {
          var r = liveRoute('NLB+' + e.routeId, String(e.routeNo || e.routeId), ['nlb'], {
            nlbId: String(e.routeId),
            orig: { zh: e.routeName_c || '', en: e.routeName_e || '' },
            dest: { zh: e.routeName_c || '', en: e.routeName_e || '' }
          });
          r.bound.nlb = 'O';
          r._live = { type: 'nlb' };
          routes.push(r);
        });
      })()
    ];
    var settled = await Promise.all(jobs.map(function (p) {
      return p.catch(function () { return null; });
    }));
    if (!routes.length) throw new Error('政府 API 亦無法連線');
    var index = buildIndex({ routeList: {}, stopList: stopList, stopNames: stopNames }, true);
    // 手動放入 live 路線（buildIndex 需要 routeList 物件）
    var map = {};
    routes.forEach(function (r) { map[r.key] = r; index.byKey[r.key] = r; });
    index.routes = routes;
    index.stopNames = stopNames;
    routes.forEach(function (r) { r._q = norm([r.route, zh(r.orig), en(r.orig), zh(r.dest), en(r.dest)].join('')); });
    index._settled = settled;
    return index;
  }

  /** 精簡模式：點開路線時，即時向政府 API 補齊站序 */
  async function ensureStops(index, r) {
    if (!index.live || !r._live || r._resolved) return r;
    r._resolved = true;
    var t = r._live.type;
    try {
      if (t === 'kmb') {
        var dir = r._live.bound === 'I' ? 'inbound' : 'outbound';
        var url = E.KMB + '/route-stop/' + encodeURIComponent(r.route) + '/' + dir + '/' + encodeURIComponent(r._live.serviceType);
        var d = (await api.getJSON(url)).data || [];
        d.sort(function (a, b) { return a.seq - b.seq; });
        r.stops.kmb = d.map(function (e) { return e.stop; });
      } else if (t === 'ctb') {
        var list = [];
        for (var i = 0; i < 2; i++) {
          var direction = i === 0 ? 'outbound' : 'inbound';
          try {
            var res = (await api.getJSON(E.CTB + '/route-stop/CTB/' + encodeURIComponent(r.route) + '/' + direction)).data || [];
            if (res.length) { list = res; r.bound.ctb = i === 0 ? 'O' : 'I'; break; }
          } catch (e) {}
        }
        list.sort(function (a, b) { return a.seq - b.seq; });
        r.stops.ctb = list.map(function (e) { return e.stop; });
        await api.mapLimit(list.slice(0, 80), 4, async function (e) {
          try {
            var s = (await api.getJSON(E.CTB + '/stop/' + encodeURIComponent(e.stop))).data || {};
            index.stopList[e.stop] = { location: { lat: Number(s.lat), lng: Number(s.long) },
              name: { zh: s.name_tc, en: s.name_en } };
          } catch (err) {}
        });
      } else if (t === 'gmb') {
        var info = (await api.getJSON(E.GMB + '/route/' + encodeURIComponent(r._live.region) + '/' + encodeURIComponent(r.route))).data || [];
        var arr = Array.isArray(info) ? info : [info];
        var first = arr[0] || {};
        r.gtfsId = String(first.route_id || '');
        if (r.gtfsId) index.byGtfsId[r.gtfsId] = { route: r.route, dest: zh(r.dest) };
        var seq = 1;
        var rs = (await api.getJSON(E.GMB + '/route-stop/' + encodeURIComponent(r.gtfsId) + '/' + seq)).data || {};
        var rsList = rs.route_stops || [];
        var raw = Array.isArray(rs) ? rs :
          (Array.isArray(rsList) ? rsList : Object.keys(rsList).map(function (k) { return rsList[k]; }));
        r.stops.gmb = raw.map(function (e) { return String(e.stop_id || e.stop); });
        raw.forEach(function (e) {
          var sid = String(e.stop_id || e.stop);
          index.stopList[sid] = { location: { lat: Number(e.latitude || e.lat || 0), lng: Number(e.longitude || e.long || 0) },
            name: { zh: e.stop_name_c || e.stop_name_tc || e.name_tc || sid, en: e.stop_name_e || e.name_en || sid } };
        });
      } else if (t === 'nlb') {
        var nd = (await api.getJSON(E.NLB + '/stop.php?action=list&routeId=' + encodeURIComponent(r.nlbId))).stops || [];
        r.stops.nlb = nd.map(function (e) { return String(e.stopId); });
        nd.forEach(function (e) {
          var sid = String(e.stopId);
          index.stopList[sid] = { location: { lat: Number(e.latitude), lng: Number(e.longitude) },
            name: { zh: e.stopName_c, en: e.stopName_e } };
        });
      }
    } catch (e) { /* 保留空站序，UI 會顯示提示 */ }

    // 補上 stopIndex 與搜尋字串
    (r.co || []).forEach(function (co) {
      (r.stops[co] || []).forEach(function (sid, seq) {
        if (!index.stopIndex[sid]) index.stopIndex[sid] = [];
        index.stopIndex[sid].push({ key: r.key, co: co, seq: seq, bound: r.bound[co] || 'O' });
      });
    });
    r._q = routeText(index, r);
    return r;
  }

  /* ---------- 載入與自動更新 ---------- */
  function validIndex(json) {
    return !!(json && json.routeList && typeof json.routeList === 'object' &&
      Object.keys(json.routeList).length);
  }

  async function loadFromSources() {
    var urls = C.INDEX_URLS || [];
    for (var i = 0; i < urls.length; i++) {
      try {
        var json = await cachedJSON(urls[i], 20000);
        if (validIndex(json)) return buildIndex(json, false);
      } catch (e) { /* 換下一個來源 */ }
    }
    return null;
  }

  /** 首次載入：先比對版本，版本變了就清掉舊快取再抓 */
  async function load() {
    var v = await fetchVersion();
    if (v && readVersion() && v !== readVersion()) await invalidateIndexCache();
    var index = await loadFromSources();
    if (index) {
      if (v) writeVersion(v);
      index.version = v || '';
      return index;
    }
    var live = await buildLiveIndex();
    live.version = '';
    return live;
  }

  /** 背景檢查：版本號不同才重新下載；下載失敗不更新版本，下次再試 */
  async function checkForUpdate() {
    var v = await fetchVersion();
    if (!v || v === readVersion()) return null;
    await invalidateIndexCache();
    var index = await loadFromSources();
    if (!index) return null;
    writeVersion(v);
    index.version = v;
    return { version: v, index: index };
  }

  /**
   * 啟動自動更新監看。定時檢查 + 由背景回到前景即時檢查。
   * onUpdate 收到 { version, index }；回傳 stop() 可停止。
   */
  function startVersionWatcher(onUpdate) {
    var busy = false;
    var tick = async function () {
      if (busy) return;
      busy = true;
      try {
        var res = await checkForUpdate();
        if (res && typeof onUpdate === 'function') onUpdate(res);
      } catch (e) {} finally { busy = false; }
    };
    var timer = setInterval(tick, C.VERSION_CHECK_MS || 300000);
    var onVisible = function () {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return function () {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }

  /* ---------- 搜尋 ---------- */
  function companiesFor(mode) {
    return mode === 'gmb' ? ['gmb'] : ['kmb', 'ctb', 'nlb', 'lrtfeeder'];
  }

  function search(index, term, mode) {
    var q = norm(term);
    var cos = companiesFor(mode);
    var list = index.routes.filter(function (r) {
      return (r.co || []).some(function (c) { return cos.indexOf(c) >= 0; });
    });
    if (!q) return list.slice(0, 30);
    var scored = [];
    list.forEach(function (r) {
      var rn = norm(r.route), score = -1;
      if (rn === q) score = 100;
      else if (rn.indexOf(q) === 0) score = 80;
      else if (rn.indexOf(q) > 0) score = 60;
      else if ((r._q || '').indexOf(q) >= 0) score = 25;
      if (score >= 0) scored.push({ r: r, s: score });
    });
    scored.sort(function (a, b) {
      return b.s - a.s || String(a.r.route).localeCompare(String(b.r.route), 'zh-Hant', { numeric: true });
    });
    return scored.slice(0, 60).map(function (x) { return x.r; });
  }

  /* ---------- 附近車站 ---------- */
  function haversine(a, b, c, d) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (c - a) * rad, dLng = (d - b) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** 精簡模式沒有完整站序索引，依站號格式判斷營辦商 */
  function guessCo(sid) {
    var s = String(sid);
    if (/^[0-9A-Fa-f]{16}$/.test(s)) return 'kmb';
    if (/^\d{6}$/.test(s)) return 'ctb';
    if (/^\d{8,9}$/.test(s)) return 'gmb';
    return 'nlb';
  }

  function nearby(index, lat, lng, mode) {
    var cos = companiesFor(mode), out = [];
    Object.keys(index.stopList).forEach(function (sid) {
      var s = index.stopList[sid], loc = (s && s.location) || {};
      var la = Number(loc.lat), lo = Number(loc.lng != null ? loc.lng : loc.long);
      if (!isFinite(la) || !isFinite(lo) || (!la && !lo)) return;
      var hits = (index.stopIndex[sid] || []).filter(function (x) { return cos.indexOf(x.co) >= 0; });
      var companies;
      if (hits.length) {
        companies = uniq(hits.map(function (x) { return x.co; }));
      } else if (index.live && cos.indexOf(guessCo(sid)) >= 0) {
        companies = [guessCo(sid)];
      } else return;
      var d = haversine(lat, lng, la, lo);
      if (d <= C.NEARBY_RADIUS_M) {
        out.push({ id: sid, lat: la, lng: lo, distance: Math.round(d),
          name: stopName(index, sid, 'zh'), companies: companies, routes: hits });
      }
    });
    out.sort(function (a, b) { return a.distance - b.distance; });
    return out.slice(0, C.NEARBY_LIMIT);
  }

  function stopName(index, id, lang) {
    var s = index.stopList[id];
    if (s) return (lang === 'en' ? en(s.name) : zh(s.name)) || zh(s.name) || id;
    var n = index.stopNames[id];
    if (n) return (lang === 'en' ? n.en : n.zh) || id;
    return String(id).length > 12 ? String(id).slice(0, 10) + '…' : String(id);
  }

  function stopLocation(index, id) {
    var s = index.stopList[id], loc = (s && s.location) || {};
    return { lat: Number(loc.lat), lng: Number(loc.lng != null ? loc.lng : loc.long) };
  }

  window.HKBUS.data = {
    load: load, search: search, nearby: nearby, ensureStops: ensureStops,
    stopName: stopName, stopLocation: stopLocation, norm: norm, zh: zh, en: en,
    fetchVersion: fetchVersion, checkForUpdate: checkForUpdate,
    startVersionWatcher: startVersionWatcher
  };
})();
