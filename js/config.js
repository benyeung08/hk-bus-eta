/* ============================================================
 * 香港巴士到站預報 · 設定檔
 * 改完存檔、push 到 GitHub 就會生效，不需要重新打包。
 * ============================================================ */
(function () {
  /* 以本檔案所在位置推算網站根目錄，放到任何子路徑（GitHub Pages 專案頁）都正確。 */
  var script = document.currentScript;
  var base = script && script.src
    ? new URL('../', script.src).href
    : new URL('.', document.baseURI).href;

  window.HKBUS_CONFIG = {
    /* ① 本站自產索引：由 .github/workflows/pages.yml 每天兩次自動抓取產生。
     * ② ③ 備援：上游每日公開檔（本站部署失敗時仍可用）。
     * 三者都失敗才會進入「政府 API 精簡模式」。依序嘗試。 */
    INDEX_URLS: [
      base + 'data/routeFareList.min.json',
      'https://data.hkbus.app/routeFareList.min.json',
      'https://raw.githubusercontent.com/hkbus/hk-bus-crawling/gh-pages/routeFareList.min.json'
    ],

    /* 版本檔很小，前端定時比對內容雜湊；變了就自動換新索引，不用重新整理頁面。 */
    VERSIONS_URL: base + 'data/versions.json',
    VERSION_CHECK_MS: 5 * 60 * 1000, // 每 5 分鐘檢查一次；由前景返回時也會即時檢查

    /* 如果你的網絡／瀏覽器阻擋跨域，把 PROXY 設成自建轉發服務，例如：
     *   'https://your-worker.your-subdomain.workers.dev/?url='
     * 只會套用到即時 ETA API；索引讀取一律走同源／直接連線。
     * README 內附一段 20 行的 Cloudflare Worker 範例。留空 = 直接連政府 API。 */
    PROXY: '',

    REFRESH_MS: 30000,        // 到站預報自動刷新（毫秒）
    REQUEST_TIMEOUT_MS: 12000,
    INDEX_CACHE_MS: 6 * 60 * 60 * 1000, // 索引快取 6 小時（版本變更會立即失效）
    NEARBY_RADIUS_M: 600,
    NEARBY_LIMIT: 10,
    MAX_STOP_BOARD_ROUTES: 8, // 站牌頁最多同時查幾條路線
    ETA_CONCURRENCY: 4,
    MAP_CENTER: [22.3193, 114.1694],
    MAP_ZOOM: 12
  };
})();
