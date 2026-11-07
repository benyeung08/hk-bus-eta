# 香港巴士到站預報 · HK Bus ETA

一個**全新撰寫、純靜態、無框架、無廣告、無追蹤**的香港巴士／專線小巴到站預報網站，可直接放到 GitHub Pages。

功能對齊 hkbus.app 的日常核心使用情境：路線／地點／站名搜尋、即時到站預報、巴士與小巴切換、附近車站站牌、收藏與瀏覽紀錄、路線地圖、自動刷新、繁中／英文、深淺色主題，以及**每日自動更新路線資料**。

---

## 一、三分鐘上線

1. 在 GitHub 建立一個新 repository（例如 `hk-bus-eta`），**Public**。
2. 把本目錄所有檔案上傳（保留 `.github/`、`scripts/` 與 `.nojekyll`）：
   ```bash
   git init
   git add -A
   git commit -m "init HK Bus ETA"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/hk-bus-eta.git
   git push -u origin main
   ```
3. 到 **Settings → Pages**，把 Source 設為 **GitHub Actions**。

`.github/workflows/pages.yml` 會在第一次 push 時**自動抓取路線資料、產生 `data/`、然後部署**，不用先手動準備任何檔案。完成後網址是 `https://<你的帳號>.github.io/hk-bus-eta/`。

> 想看部署紀錄：**Actions → Refresh route data & deploy to GitHub Pages**。

本機預覽（不要用 `file://` 直接開，瀏覽器會擋 fetch）：

```bash
python3 scripts/build_data.py      # 先產生 data/（可省略，會自動改用備援來源）
python3 -m http.server 8080
# 開 http://localhost:8080
```

---

## 二、資料是怎麼來的

分兩層，刻意拆開，方便自行替換：

| 層 | 內容 | 來源 |
|---|---|---|
| 靜態索引 | 路線、方向、站序、站名、座標、收費 | **本站 Actions 每日自動產生**的 `data/routeFareList.min.json`；上游是每日更新的公開 JSON，原始資料來自 DATA.GOV.HK |
| 即時預報 | 每一班車的預計到站時間 | **瀏覽器直接打政府／營辦商開放 API**，不經任何後端 |

即時 ETA 端點（全部在 `js/api.js`）：

| 營辦商 | 端點 |
|---|---|
| 九巴／龍運 | `https://data.etabus.gov.hk/v1/transport/kmb/eta/{stop}/{route}/{serviceType}`、`/stop-eta/{stop}` |
| 城巴 | `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/{stop}/{route}`、`/v1/transport/batch/stop-eta/CTB/{stop}` |
| 專線小巴 | `https://data.etagmb.gov.hk/eta/route-stop/{routeId}/{stopId}`、`/eta/stop/{stopId}` |
| 嶼巴 | `https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&...` |

**索引掛掉也不會白畫面**：本站 `data/` → 上游公開檔（兩個網址）→ 全部失敗才進「政府 API 精簡模式」，直接向四家營辦商拉路線清單並按需補站序（頂部會顯示「精簡模式」）。

---

## 三、自動更新路線資料

這是這次加進來的核心，兩端都自動，不用你手動按、也不用訪客重新整理。

### 觸發時機

| 時機 | 說明 |
|---|---|
| `push` 到 `main` | 改程式碼時順便更新資料 |
| 每天 06:00 與 18:00 HKT | `schedule`：UTC `22:00` / `10:00`（GitHub Actions 用 UTC） |
| 手動 | **Actions → Run workflow**，隨時強制重抓 |

> GitHub 的排程不保證準點，繁忙時可能延後數十分鐘，屬正常現象。

### 後端做什麼（`scripts/build_data.py`）

1. 依序嘗試 4 個公開來源（正式站台 / GitHub Pages 原始檔，各含 minified 與完整版）。
2. **結構校驗**：必須是 JSON、含 `routeList`／`stopList`、數量合理、抽樣檢查欄位，避免抓到 403 頁面或被截斷的檔還照樣部署。
3. **精簡**：只保留前端真正用到的欄位（去掉 holidays、freq、jt、stopMap…），檔案明顯變小。
4. **版本號 = 內容的 SHA-256 前 16 碼**。上游沒改，版本就不變，前端不會無謂重載。
5. 寫出 `data/routeFareList.min.json` 與 `data/versions.json`，接著部署整站。

`data/versions.json` 長這樣：

```json
{"schema":1,"status":"ok","version":"a1b2c3d4e5f60718",
 "generated_at":"2026-11-08T06:00:12+08:00","source":"...","routes":1234,"stops":5678,"bytes":2345678}
```

### 前端怎麼感知（`js/data.js`）

- 開頁先讀很小的 `versions.json`，比對本機記的版本號；不同就**清掉舊快取**再抓新索引。
- 之後每 5 分鐘檢查一次；**從背景切回前景也會即時檢查**。
- 版本變了就熱換索引並重繪目前的頁面（搜尋結果、路線頁、站牌都會更新），頂部短暫顯示「🔄 路線資料已自動更新」。
- 索引檔用 Cache Storage 快取 6 小時（不受 localStorage 5MB 限制）；版本變更會立刻讓它失效。

### 失敗時的行為

| 情況 | 結果 |
|---|---|
| 某個來源 403 / 超時 | 自動換下一個，含重試 |
| 全部來源失敗 | **不中斷部署**；保留上一次成功的索引，前端照常可用 |
| 第一次部署就全失敗 | 寫出 `status: unavailable` 標記，前端自動降級到上游來源或政府 API 精簡模式 |
| `versions.json` 讀不到 | 視為「不確定」，不觸發重載，避免誤清快取 |

### 常用指令

```bash
# 本機重抓一次
python3 scripts/build_data.py

# 指定自己的來源（重複參數可給多個，也可用本機檔案路徑）
python3 scripts/build_data.py --source https://your.domain/routeFareList.min.json

# 離線驗證腳本邏輯（不連網絡）
python3 scripts/build_data.py --fixture /path/to/sample.json --out /tmp/hkbus-data

# 想讓 CI 在全部來源失敗時亮紅燈
python3 scripts/build_data.py --strict
```

改更新頻率：編輯 `.github/workflows/pages.yml` 的 `cron`（記得是 UTC）。改版本輪詢頻率：編輯 `js/config.js` 的 `VERSION_CHECK_MS`。

---

## 四、設定（`js/config.js`）

| 項目 | 說明 |
|---|---|
| `INDEX_URLS` | 索引來源，依序嘗試。第一項是本站自產的 `data/routeFareList.min.json`，後兩項是備援。想完全換掉上游，改 `scripts/build_data.py` 的 `SOURCES`。 |
| `VERSIONS_URL` | 版本檔位置，預設同源的 `data/versions.json`。 |
| `VERSION_CHECK_MS` | 背景檢查間隔，預設 5 分鐘。 |
| `PROXY` | 留空＝直連。若瀏覽器／網絡擋跨域，填入自建轉發服務前綴，例如 `https://xxx.workers.dev/?url=`。**只套用到即時 ETA**，索引讀取不受影響。 |
| `REFRESH_MS` | 到站預報自動刷新，預設 30 秒。 |
| `INDEX_CACHE_MS` | 索引快取，預設 6 小時（版本變更立即失效）。 |
| `NEARBY_RADIUS_M` / `NEARBY_LIMIT` | 附近車站半徑與數量。 |

設定檔用 `document.currentScript.src` 推算網站根目錄，所以放在 GitHub Pages 專案頁（子路徑）也正確。

### 可選：跨域轉發（Cloudflare Worker）

只有當你看到「資料連線失敗」才需要。部署一個 Worker，貼上：

```js
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    const allow = [
      'https://data.etabus.gov.hk/',
      'https://rt.data.gov.hk/',
      'https://data.etagmb.gov.hk/'
    ];
    if (!target || !allow.some(p => target.startsWith(p)))
      return new Response('forbidden', { status: 403 });
    const res = await fetch(target, { headers: { Accept: 'application/json' } });
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
};
```

再把 `PROXY` 設成 `https://<你的 Worker 網域>/?url=`。ETA 仍然直接取自政府原始回應，轉發只做搬運。

---

## 五、使用小貼士

- 頂部 **巴士／小巴** 分頁會過濾搜尋結果與附近車站。
- 路線頁的站序用「捲到才查」的方式載入預報，不會一次打爆 API；按 **↻** 可重刷已看過的站。
- 點 **🗺 路線地圖** 才會載入 Leaflet／OpenStreetMap，平時不耗流量。
- 收藏、紀錄、語言、主題都存在瀏覽器本機，不上傳、不登入。
- 小巴的「未開出／Scheduled」是**班次表預估**，不是車輛 GPS 即時位置，介面會原樣標示。

---

## 六、已知限制

- 涵蓋九巴／龍運、城巴、嶼巴、綠色專線小巴；**不含**輕鐵、港鐵、港鐵巴士、渡輪、電車、紅色小巴。
- 聯營路線（如過海線）以站序最完整的營辦商為主顯示站名，ETA 仍會合併各家回報。
- 嶼巴沒有「整站一次查」API，站牌頁會改由站序索引逐線查詢，班次較少時可能顯示較慢。
- 精簡模式只載入路線號與必要站序，收費／班次表等進階資訊不會顯示。
- 每日更新依赖上游公開索引；若上游改了欄位結構，`build_data.py` 的校驗會擋下並保留舊索引，不會部署壞資料。
- 排程更新有 GitHub Actions 的固有延遲；需要即時可手動 Run workflow。
- 預報只供參考，實際服務受交通及營運情況影響；臨時改道請以營辦商公告為準。

---

## 七、授權與鳴謝

- 本專案的**程式碼**為全新撰寫，採 MIT License（見 `LICENSE`）。
- 路線／車站資料來自 `hkbus/hk-bus-crawling` 每日產生的公開 JSON（該專案為 GPL-3.0），原始資料來自 DATA.GOV.HK。本專案**不複製其程式碼**，但自動更新會把該資料檔鏡像並精簡後放到自己的 GitHub Pages；**若要商用，請先確認該資料的授權與再散佈條款**，或改用 `SOURCES` 指向自行產生的索引。
- 即時到站資料來自運輸署「資料一站通」及各營辦商開放 API，須遵守 [DATA.GOV.HK 使用條款](https://data.gov.hk/tc/terms-and-conditions)。
- 本站為非官方服務，與運輸署及各交通營辦商並無關聯。
- 介面構思參考 hkbus.app 的無廣告理念；如需完整功能（行程規劃、小工具、輕鐵港鐵等），建議直接使用原站或 fork 其 GPL-3.0 官方倉庫。
