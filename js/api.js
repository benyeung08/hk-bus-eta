/* ============================================================
 * api.js — 直接串接香港運輸署／營辦商的即時到站 (ETA) 開放 API
 * 來源：
 *   九巴／龍運  https://data.etabus.gov.hk/v1/transport/kmb/...
 *   城巴        https://rt.data.gov.hk/v2/transport/citybus/...
 *   城巴整站    https://rt.data.gov.hk/v1/transport/batch/...
 *   專線小巴    https://data.etagmb.gov.hk/...
 *   嶼巴        https://rt.data.gov.hk/v2/transport/nlb/...
 * ============================================================ */
(function () {
  'use strict';

  var C = window.HKBUS_CONFIG;
  var KMB = 'https://data.etabus.gov.hk/v1/transport/kmb';
  var CTB = 'https://rt.data.gov.hk/v2/transport/citybus';
  var CTB_BATCH = 'https://rt.data.gov.hk/v1/transport/batch';
  var GMB = 'https://data.etagmb.gov.hk';
  var NLB = 'https://rt.data.gov.hk/v2/transport/nlb';

  function resolve(url) {
    return C.PROXY ? C.PROXY + encodeURIComponent(url) : url;
  }

  /** 帶 timeout 的 JSON GET；失敗會 throw，由呼叫端降級 */
  async function getJSON(url, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || C.REQUEST_TIMEOUT_MS);
    try {
      var res = await fetch(resolve(url), {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 限制併發，避免一次打爆政府 API（429） */
  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length);
    var i = 0;
    var n = Math.min(limit, items.length);
    var workers = [];
    for (var w = 0; w < n; w++) {
      workers.push((async function () {
        while (i < items.length) {
          var idx = i++;
          try { out[idx] = await fn(items[idx], idx); }
          catch (e) { out[idx] = []; }
        }
      })());
    }
    await Promise.all(workers);
    return out;
  }

  function enc(v) { return encodeURIComponent(String(v)); }

  function makeEta(co, eta, remark, dest, seq) {
    return { co: co, eta: eta || null, remark: remark || '', dest: dest || '', seq: seq || 0 };
  }

  function nearestSeq(rows, seq) {
    rows.sort(function (a, b) { return Math.abs(seq - a.seq) - Math.abs(seq - b.seq); });
    if (!rows.length) return rows;
    var n = rows[0].seq;
    return rows.filter(function (e) { return e.seq === n; });
  }

  /* ---------------- 九巴 / 龍運 ---------------- */
  async function kmbEta(entry, stopId, seq) {
    var bound = entry.bound.kmb || 'O';
    var st = String(entry.serviceType || '1');
    var url = KMB + '/eta/' + enc(stopId) + '/' + enc(entry.route) + '/' + enc(st);
    var data = (await getJSON(url)).data || [];
    var rows = data.filter(function (e) { return e.eta && bound.indexOf(e.dir) >= 0; });
    rows = nearestSeq(rows, seq);
    var multi = entry.co.length > 1;
    rows = rows.filter(function (e) {
      return multi || String(e.service_type || '1') === st || e.seq === seq + 1;
    });
    return rows.map(function (e) {
      return makeEta('kmb', e.eta, e.rmk_tc || e.rmk_en, e.dest_tc || e.dest_en, e.eta_seq);
    });
  }

  /* ---------------- 城巴 ---------------- */
  async function ctbEta(entry, stopId, seq) {
    var bound = entry.bound.ctb || 'O';
    var url = CTB + '/eta/CTB/' + enc(stopId) + '/' + enc(entry.route);
    var data = (await getJSON(url)).data || [];
    var rows = data.filter(function (e) { return e.eta && bound.indexOf(e.dir) >= 0; });
    rows = nearestSeq(rows, seq);
    return rows.map(function (e) {
      return makeEta('ctb', e.eta, e.rmk_tc || e.rmk_en, e.dest_tc || e.dest_en, e.eta_seq);
    });
  }

  /* ---------------- 綠色專線小巴 ---------------- */
  function normaliseGmbRows(candidates, routeSeq, seq) {
    var arr = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);
    var rows = arr.filter(function (e) {
      return e && e.enabled &&
        (e.route_seq == null || Number(e.route_seq) === routeSeq) &&
        (e.stop_seq == null || Number(e.stop_seq) === seq + 1);
    });
    return rows.reduce(function (acc, e) {
      (e.eta || []).forEach(function (x) {
        acc.push(makeEta('gmb', x.timestamp, x.remarks_tc || x.remarks_en, '', x.eta_seq));
      });
      return acc;
    }, []);
  }

  async function gmbEta(entry, stopId, seq) {
    if (!entry.gtfsId) return [];
    var bound = entry.bound.gmb || 'O';
    var routeSeq = bound.charAt(0) === 'O' ? 1 : 2;
    try {
      var url = GMB + '/eta/route-stop/' + enc(entry.gtfsId) + '/' + enc(stopId);
      var d = (await getJSON(url)).data;
      var rows = normaliseGmbRows(d, routeSeq, seq);
      if (rows.length) return rows;
    } catch (e) { /* 試另一種參數形式 */ }
    try {
      var url2 = GMB + '/eta/route-stop/' + enc(entry.gtfsId) + '/' + routeSeq + '/' + (seq + 1);
      var d2 = (await getJSON(url2)).data;
      return normaliseGmbRows(d2, routeSeq, seq);
    } catch (e) { return []; }
  }

  /* ---------------- 新大嶼山巴士 ---------------- */
  function nlbTime(s) {
    var iso = String(s).trim().replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += '+08:00';
    return iso;
  }

  async function nlbEta(entry, stopId) {
    if (!entry.nlbId) return [];
    var url = NLB + '/stop.php?action=estimatedArrivals&routeId=' + enc(entry.nlbId) +
      '&stopId=' + enc(stopId) + '&language=zh';
    var d = (await getJSON(url)).estimatedArrivals || [];
    return d.filter(function (e) { return e.estimatedArrivalTime; }).map(function (e, i) {
      var remark = e.routeVariantName || (Number(e.noGPS) === 1 ? '無 GPS 資料' : '');
      return makeEta('nlb', nlbTime(e.estimatedArrivalTime), remark, '', i + 1);
    });
  }

  /**
   * 取「某一路線的第 seq 個站」的所有到站預報。
   * entry 為 routeFareList 的單一路線物件。
   */
  async function etaForStop(entry, seq) {
    var jobs = [];
    (entry.co || []).forEach(function (co) {
      var stopId = (entry.stops[co] || [])[seq];
      if (!stopId) return;
      if (co === 'kmb') jobs.push(function () { return kmbEta(entry, stopId, seq); });
      else if (co === 'ctb') jobs.push(function () { return ctbEta(entry, stopId, seq); });
      else if (co === 'gmb') jobs.push(function () { return gmbEta(entry, stopId, seq); });
      else if (co === 'nlb') jobs.push(function () { return nlbEta(entry, stopId); });
    });
    var results = await mapLimit(jobs, C.ETA_CONCURRENCY, function (fn) { return fn(); });
    var flat = results.reduce(function (a, b) { return a.concat(b || []); }, []);
    return flat.filter(function (x) { return x.eta || x.remark; }).sort(function (a, b) {
      var ta = a.eta ? new Date(a.eta).getTime() : Infinity;
      var tb = b.eta ? new Date(b.eta).getTime() : Infinity;
      return ta - tb;
    });
  }

  /* ---------------- 整站站牌（附近車站用） ---------------- */
  async function kmbStopEta(stopId) {
    var d = (await getJSON(KMB + '/stop-eta/' + enc(stopId))).data || [];
    return d.filter(function (e) { return e.eta; }).map(function (e) {
      return { route: e.route, co: 'kmb', dest: e.dest_tc || e.dest_en || '', eta: e.eta,
        remark: e.rmk_tc || e.rmk_en || '', seq: e.eta_seq, dir: e.dir };
    });
  }

  async function ctbStopEta(stopId) {
    var d = (await getJSON(CTB_BATCH + '/stop-eta/CTB/' + enc(stopId))).data || [];
    return d.filter(function (e) { return e.eta; }).map(function (e) {
      return { route: e.route, co: 'ctb', dest: e.dest || '', eta: e.eta,
        remark: e.rmk || '', seq: e.eta_seq, dir: e.dir };
    });
  }

  async function gmbStopEta(stopId, index) {
    var d = (await getJSON(GMB + '/eta/stop/' + enc(stopId))).data || [];
    var arr = Array.isArray(d) ? d : [d];
    var out = [];
    arr.forEach(function (e) {
      if (!e || !e.enabled) return;
      var meta = (index.byGtfsId || {})[String(e.route_id)] || {};
      (e.eta || []).forEach(function (x) {
        out.push({ route: meta.route || '—', co: 'gmb', dest: meta.dest || '', eta: x.timestamp,
          remark: x.remarks_tc || x.remarks_en || '', seq: x.eta_seq, dir: e.route_seq === 1 ? 'O' : 'I' });
      });
    });
    return out;
  }

  /** 一次拿同一個站所有路線的預報，回傳已排序的站牌陣列 */
  async function fetchStopBoard(stopId, companies, index) {
    var jobs = [];
    if (companies.indexOf('kmb') >= 0) jobs.push(function () { return kmbStopEta(stopId); });
    if (companies.indexOf('ctb') >= 0) jobs.push(function () { return ctbStopEta(stopId); });
    if (companies.indexOf('gmb') >= 0) jobs.push(function () { return gmbStopEta(stopId, index); });
    // 嶼巴沒有「整站」API，改由 stopIndex 逐線查詢（見 app.js）
    var res = await mapLimit(jobs, 3, function (fn) { return fn(); });
    var flat = res.reduce(function (a, b) { return a.concat(b || []); }, []);
    return flat.sort(function (a, b) {
      return (a.eta ? new Date(a.eta).getTime() : Infinity) - (b.eta ? new Date(b.eta).getTime() : Infinity);
    });
  }

  window.HKBUS = window.HKBUS || {};
  window.HKBUS.api = {
    getJSON: getJSON,
    mapLimit: mapLimit,
    etaForStop: etaForStop,
    fetchStopBoard: fetchStopBoard,
    endpoints: { KMB: KMB, CTB: CTB, CTB_BATCH: CTB_BATCH, GMB: GMB, NLB: NLB }
  };
})();
