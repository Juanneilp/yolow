# Yolow Agent

Yolow memantau posisi Meteora DLMM milik satu wallet Solana, menampilkan PnL per posisi, dan mengirim notifikasi ke satu chat Telegram yang diizinkan. Sinyal indikator atau out-of-range (OOR) dapat memicu penutupan posisi penuh, dilanjutkan swap token ke SOL melalui Jupiter. Mode awal instalasi baru adalah **DRY-RUN**: simulasi tanpa tanda tangan atau broadcast transaksi.

## Daftar isi

- [Instalasi](#instalasi)
- [Menjalankan dan mengelola proses](#menjalankan-dan-mengelola-proses)
- [Penggunaan Telegram](#penggunaan-telegram)
- [Mengubah konfigurasi](#mengubah-konfigurasi)
- [Referensi parameter](#referensi-parameter)
- [Keamanan dan mode LIVE](#keamanan-dan-mode-live)
- [Batasan dan pemecahan masalah](#batasan-dan-pemecahan-masalah)

## Instalasi

### 1. Siapkan kebutuhan

Pasang Git, **Node.js ≥ 22.21.0**, dan npm. Siapkan bot Telegram beserta token dan ID chat, API key Helius, serta public key wallet yang akan dipantau. API key Jupiter diperlukan dengan konfigurasi bawaan karena swap dan Top Trending aktif. GMGN opsional untuk data ATH Top Trending.

```sh
node --version
npm --version
git clone https://github.com/Juanneilp/yolow.git
cd yolow
npm ci
cp config.example.json config.json
cp .env.example .env
chmod 600 .env config.json
```

Gunakan akun GitHub yang memiliki akses bila repository privat. Jalankan seluruh perintah berikutnya dari direktori `yolow`.

### 2. Isi `.env`

Edit `.env` menggunakan editor teks. Jangan menyalin tanda `...` sebagai nilai sebenarnya.

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_USER_ID=
HELIUS_API_KEY=...
AGENT_WALLET_PUBKEY=...
JUPITER_API_KEY=...
```

Untuk chat pribadi, `TELEGRAM_USER_ID` boleh kosong karena mengikuti ID chat. Untuk grup, isi ID numerik pengguna yang boleh mengontrol bot. Daftar seluruh variabel tersedia di [parameter environment](#parameter-environment).

### 3. Periksa konfigurasi dan mulai

`config.json` memakai nilai dari [config.example.json](config.example.json). Pertahankan `mode.dry_run: true` untuk instalasi awal, lalu jalankan:

```sh
npm start
```

Di Telegram, buka bot, kirim `/start`, lalu `/status` dan `/positions`. Pastikan wallet dan mode benar. Posisi baru dapat memerlukan sekitar lima menit untuk terdeteksi. Hentikan proses terminal dengan `Ctrl+C` sebelum beralih ke PM2 agar tidak menjalankan dua bot sekaligus.

## Menjalankan dan mengelola proses

Untuk menjalankan di latar belakang, pasang PM2 jika belum tersedia:

```sh
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 status yolow
pm2 logs yolow --lines 25 --nostream
pm2 save
```

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Jalankan langsung; memuat `.env` dan source TypeScript, tanpa build terpisah. |
| `pm2 restart yolow` | Muat ulang source, konfigurasi file, dan `.env`. |
| `pm2 stop yolow` | Hentikan bot. |
| `pm2 resurrect` | Pulihkan daftar proses yang sebelumnya disimpan dengan `pm2 save`. |
| `npm test` | Jalankan suite pengujian untuk pengembangan. |

`pm2 save` menyimpan daftar proses, tetapi tidak memasang autostart OS. Pada host yang mendukung layanan startup, jalankan `pm2 startup` dan ikuti instruksi yang dicetak; pada lingkungan tanpa layanan tersebut, jalankan kembali PM2 setelah reboot. PM2 tetap berjalan setelah sesi SSH/tmux ditutup.

## Penggunaan Telegram

Kirim `/menu` atau gunakan tombol **Menu**. Command didaftarkan dengan deskripsi bahasa Indonesia; `/help` menampilkan petunjuk yang sama. Kontrol memerlukan kecocokan **ID chat dan ID pengirim**.

| Command | Fungsi / nilai bawaan |
| --- | --- |
| `/start`, `/menu`, `/help` | Mulai, buka menu, atau lihat bantuan. |
| `/status` | Status wallet, proses, dan mode eksekusi efektif. |
| `/positions`, `/pnl` | Daftar gabungan Posisi & PnL; `/pnl` merupakan alias. |
| `/tf [5m\|15m\|30m\|1h]` | Lihat/ubah timeframe global; pilihan efektif disimpan di SQLite. |
| `/ignore <position_id>`, `/unignore <position_id>` | Abaikan/aktifkan sinyal exit; pemantauan PnL tetap berjalan. |
| `/history [1–50]` | Riwayat trade; default 10 entri. |
| `/trade <trade_id\|position_id>` | Detail trade, swap, catatan, dan harga setelah exit. |
| `/stats [7d\|30d\|all]` | Statistik jurnal; default `all`. |
| `/note <trade_id\|position_id> <catatan>` | Simpan catatan trade. |
| `/tag <trade_id\|position_id> <tag>` | Tambahkan tag trade. |
| `/export` | Unduh jurnal CSV. |
| `/toptrending` | Ranking token/pool dengan tombol Refresh dan Filter. |
| `/config`, `/config set <path> <nilai>` | Buka editor atau ubah parameter yang diizinkan. |
| `/retryswap <position_id>` | Minta retry swap dari hasil close terkonfirmasi yang masih tersisa. |
| `/golive` | Minta aktivasi LIVE; memerlukan keypair dan konfirmasi dalam dua menit. |

### Posisi, PnL, dan OOR

Daftar menampilkan **lima posisi per halaman**, diurutkan menurut PnL SOL terbesar. Setiap posisi memiliki PnL SOL/%, status range, status exit, dan waktu pengambilan data. Header menunjukkan cakupan data, misalnya `PnL terhitung 3/4`; data kosong tidak dianggap nol. Tombol **Detail** menampilkan deposit, penarikan, fee/reward, bin, ID lengkap, dan kontrol exit untuk posisi tersebut. Navigasi dan refresh mengedit pesan yang sama.

Persentase OOR adalah jarak harga dari batas range yang terlewati, mengikuti urutan bin DLMM. Contoh bin step 25 dan jarak 10 bin: **OOR atas 2,53%** atau **OOR bawah 2,47%**. Nilai dihitung secara majemuk dari bin aktif terakhir, bukan persentase untuk kembali ke range; bin step yang tidak tersedia membuat persentase tidak tersedia.

PnL berasal dari indeks Meteora sejak posisi dibuka, termasuk fee/reward menurut perhitungan penyedia; **belum dikurangi gas dan slippage likuidasi**. Angka ini terpisah dari PnL jurnal DRY-RUN/LIVE. Refresh latar belakang berjalan setiap 60 detik tanpa RPC Helius. Menu/Refresh memakai batas minimum 10 detik per pool; pagination/detail memakai cache normal. Fetch gagal mempertahankan data terakhir dengan peringatan, lalu menunggu minimal 60 detik atau sesuai `Retry-After`. Waktu saldo terakhir dari penyedia yang tidak berubah tidak otomatis berarti fetch gagal.

### Notifikasi profit

Default: ringkasan gabungan setiap **5 menit** ketika ada posisi terbuka dengan PnL SOL positif dan **PnL > 5%**; tepat 5% tidak memenuhi ambang. Pesan diulang selama masih ada posisi yang memenuhi syarat, termasuk posisi yang exit-nya diabaikan. Urutan berdasarkan persentase terbesar; ringkasan panjang dibagi menjadi pesan bernomor.

Pemeriksaan mengikuti siklus PnL 60 detik, pertama kali setelah satu interval dari refresh awal. Tidak ada notifikasi ketika data kosong, fetch gagal, atau hasil fetch berumur lebih dari dua menit. Refresh manual tidak memicu pesan. Restart memulai hitungan baru; tidak ada antrean pengiriman ulang atau pengiriman susulan untuk interval terlewat. Fitur ini tidak menjalankan close/swap.

## Mengubah konfigurasi

Buka **Konfigurasi → bagian → parameter**. Boolean dan pilihan preset memakai tombol; angka, array, atau teks memakai **Ketik nilai**. Kirim `batal` untuk membatalkan. Perubahan divalidasi, disimpan secara atomik ke file, dan dicatat dalam audit SQLite.

```text
/config set notify.profit_alert.interval_minutes 10
/config set notify.profit_alert.threshold_percent 7.5
/config set notify.profit_alert.enabled false
/config set oor_exit.below.trigger_bins 24
/config set indicator_exit.enabled false
/config set candles.fallback_chain ["meteora","geckoterminal"]
```

**Legenda kolom Ubah:**

- **T**: bisa melalui Telegram, aktif tanpa restart.
- **T+R**: bisa melalui Telegram, perlu `pm2 restart yolow`.
- **F**: edit file, lalu restart; tidak tersedia melalui `/config set`.
- **Khusus**: memakai alur tersendiri, dijelaskan pada baris parameter.
- **Belum aktif**: nilai ada dalam konfigurasi, tetapi pengaruh runtime belum diterapkan.

Perubahan manual pada `.env` atau `config.json` selalu memerlukan restart. Mode efektif dan timeframe dapat diwarisi dari SQLite; mengganti file tidak otomatis mengganti nilai tersimpan tersebut. Periksa `/status` dan `/tf`.

## Referensi parameter

Kolom **Default** mengikuti file contoh yang disertakan repository, bukan konfigurasi pribadi yang sedang berjalan. Sebagian besar field wajib dicantumkan; jangan menganggap seluruh default otomatis diisi bila field dihapus. Parser secara eksplisit mengisi `top_trending.volume_window = "24h"` dan field `notify.profit_alert` yang belum ada. `jupiter.price_base_url` bersifat opsional dengan fallback di kode.

Path dalam tabel konfigurasi relatif terhadap judul kelompok: misalnya `period` pada kelompok `indicator_exit.indicators.rsi` berarti `indicator_exit.indicators.rsi.period`.

### Parameter environment

Semua variabel disimpan di `.env`, diubah melalui file, dan dimuat saat startup.

| Parameter | Default / wajib | Fungsi |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Tanpa default; wajib | Token bot Telegram. |
| `TELEGRAM_CHAT_ID` | Tanpa default; wajib | ID numerik chat tujuan; ID grup dapat negatif. |
| `TELEGRAM_USER_ID` | Mengikuti `TELEGRAM_CHAT_ID` | ID numerik pengguna pengontrol; harus diisi untuk grup. |
| `HELIUS_API_KEY` | Tanpa default; wajib | Credential RPC HTTP dan WebSocket Helius. |
| `AGENT_WALLET_PUBKEY` | Tanpa default; wajib | Public key wallet yang dipantau. |
| `JUPITER_API_KEY` | Tanpa default; wajib jika swap/trending aktif | Akses Jupiter; label token bersifat opsional ketika fitur tersebut nonaktif. |
| `GMGN_API_KEY` | Kosong; opsional | Data ATH MarketCap Top Trending; tanpa data ditampilkan `N/A`. |
| `AGENT_KEYPAIR_PATH` | Kosong; wajib untuk LIVE | Lokasi keypair JSON di luar repository; harus cocok dengan wallet. |
| `DB_PATH` | `./data/yolow.db` | Lokasi database SQLite. |
| `CONFIG_PATH` | `./config.json` | Lokasi konfigurasi JSON. |

### Dasar dan `mode`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `config_version` | `1` | Versi format; hanya `1` didukung. | F |
| `timezone` | `"Asia/Jakarta"` | Zona waktu IANA untuk jadwal dan tampilan; beberapa label pesan masih tertulis WIB. | T+R |
| `mode.dry_run` | `true` | Mode awal bila belum ada nilai tersimpan di SQLite; LIVE memerlukan signer. | Khusus: `/golive` + konfirmasi |
| `mode.shadow_candles` | `true` | Flag tersimpan; belum mengontrol pengumpulan candle. | Belum aktif |
| `mode.position_poll_interval_sec` | `300` | Interval penemuan posisi wallet, detik; integer ≥ 1. | T+R |

### `rpc`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `http_base` | `"https://mainnet.helius-rpc.com"` | Endpoint HTTPS; host Helius ini diwajibkan, tanpa credential dalam URL. | F |
| `ws_base` | `"wss://mainnet.helius-rpc.com"` | Endpoint WebSocket; host yang sama diwajibkan. | F |
| `oor_fallback_poll_interval_sec` | `15` | Interval fallback pembacaan akun per pool untuk bin aktif; integer ≥ 1 detik. | T+R |

### `candles`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `primary` | `"gmgn"` | Provider pertama; saat ini GMGN dilewati karena adapter candle belum tersedia. | T |
| `fallback_chain` | `["meteora","geckoterminal","onchain_ticks"]` | Urutan fallback; hanya Meteora dan GeckoTerminal terintegrasi. | T |
| `price_unit` | `"usd"` | Unit seri harga: `usd` atau `sol`; harus konsisten dengan sumber chart. | T |
| `poll_interval_sec` | `20` | Interval refresh candle; integer ≥ 1 detik. | T+R |
| `grace_window_sec` | `60` | Jeda setelah penutupan candle sebelum dianggap final; integer ≥ 0 detik. | T |
| `backfill_candles` | `200` | Jumlah candle historis yang diminta/dipakai; integer ≥ 35. | T |
| `stale_data_pause_sec` | `300` | Batas kegagalan untuk peringatan data terhenti; juga bagian toleransi umur candle; integer ≥ 1 detik. | T |

Candle hanya dipakai jika final dan masih cukup baru. Batas umur mencakup durasi timeframe, grace, dan toleransi stale. Bila seluruh provider gagal, exit indikator dijeda sementara OOR tetap dipantau.

### `candles.providers`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `gmgn.rate_limit_rps` | `2` | Nilai konfigurasi; adapter candle GMGN belum tersedia. | Belum aktif |
| `meteora.base_url` | `"https://dlmm.datapi.meteora.ag"` | Endpoint candle dan PnL; host ini diwajibkan. | F |
| `meteora.rate_limit_rps` | `10` | Belum dipakai sebagai pengatur laju request. | Belum aktif |
| `meteora.build_15m_from_5m` | `true` | Flag belum dibaca; agregasi 15m dari candle 5m dilakukan oleh kode. | Belum aktif |
| `geckoterminal.base_url` | `"https://api.geckoterminal.com/api/v2"` | Endpoint fallback candle; host ini diwajibkan. | F |
| `onchain_ticks.enabled` | `true` | Adapter on-chain ticks belum tersedia. | Belum aktif |
| `onchain_ticks.sol_usd_source` | `"jupiter"` | Sumber konversi yang direncanakan; belum dibaca runtime. | Belum aktif |

### `indicator_exit`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `enabled` | `true` | Aktifkan evaluasi exit indikator. | T |
| `timeframe` | `"15m"` | `5m`, `15m`, `30m`, atau `1h`; override per pool mengungguli nilai global. | T; `/tf` untuk pilihan efektif |
| `min_age_candles` | `1` | Umur minimum posisi sebelum eligible exit indikator, dihitung dalam durasi timeframe sejak mulai dipantau; integer ≥ 0. | T |
| `rule.rsi_required` | `true` | Wajibkan RSI mencapai ambang di samping konfirmasi lain. | T |
| `rule.confirmations_any_of` | `["bb_breakout","macd_first_green"]` | Minimal satu konfirmasi harus terpenuhi; array tidak kosong dari kedua nama ini. | T |

`bb_breakout`: penutupan di atas BB atas. `macd_first_green`: histogram MACD berubah dari ≤ 0 ke > 0. Jika RSI diwajibkan, RSI juga harus > `overbought` (tepat pada ambang belum memenuhi). Evaluasi memerlukan setidaknya 35 candle dan data indikator yang cukup.

### `indicator_exit.indicators`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `rsi.period` | `2` | Periode RSI Wilder; integer ≥ 1 candle. | T |
| `rsi.overbought` | `90` | Ambang RSI; angka 0–100. | T |
| `bb.period` | `20` | Periode Bollinger Bands; integer ≥ 2 candle. | T |
| `bb.std_dev` | `2` | Pengali standar deviasi BB; angka ≥ 0. | T |
| `macd.fast` | `12` | Periode EMA cepat; integer ≥ 1 dan < `slow`. | T |
| `macd.slow` | `26` | Periode EMA lambat; integer ≥ 2. | T |
| `macd.signal` | `9` | Periode EMA signal; integer ≥ 1. | T |

### `oor_exit`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `evaluation` | `"live"` | Evaluasi bin secara langsung; hanya `live` didukung. Ini bukan aktivasi transaksi LIVE. | F |
| `below.enabled` | `true` | Aktifkan exit jika bin aktif melewati batas bawah. | T |
| `below.trigger_bins` | `20` | Jarak minimal di bawah batas bawah; integer ≥ 1 bin. | T |
| `below.confirm_sec` | `5` | Kondisi bawah harus bertahan terus selama nilai ini; angka ≥ 0 detik, `0` langsung. | T |
| `above.enabled` | `true` | Aktifkan exit jika bin aktif melewati batas atas. | T |
| `above.trigger_bins` | `20` | Jarak minimal di atas batas atas; integer ≥ 1 bin. | T |
| `above.confirm_sec` | `30` | Kondisi atas harus bertahan terus; angka ≥ 0 detik. | T |

Konfirmasi direset bila kondisi ambang tidak lagi terpenuhi. Bin step berbeda menghasilkan jarak harga berbeda untuk jumlah bin yang sama; ambang exit ini tetap memakai bin, bukan persen OOR di UI.

### `pool_overrides`

Default **`{}`**: semua pool memakai konfigurasi global. Key adalah alamat pool. Field yang tidak dicantumkan mewarisi nilai global.

| Parameter di bawah `pool_overrides.<pool>` | Default | Fungsi / nilai | Ubah |
| --- | --- | --- | --- |
| `indicator_exit.timeframe` | Global `"15m"` | Timeframe khusus pool: `5m`, `15m`, `30m`, `1h`. | T |
| `oor_exit.below.enabled` | Global `true` | Aktifkan/nonaktifkan exit bawah pool. | T |
| `oor_exit.below.trigger_bins` | Global `20` | Integer ≥ 1 bin. | T |
| `oor_exit.below.confirm_sec` | Global `5` | Angka ≥ 0 detik. | T |
| `oor_exit.above.enabled` | Global `true` | Aktifkan/nonaktifkan exit atas pool. | T |
| `oor_exit.above.trigger_bins` | Global `20` | Integer ≥ 1 bin. | T |
| `oor_exit.above.confirm_sec` | Global `30` | Angka ≥ 0 detik. | T |

Contoh blok dalam `config.json`; ganti `<ALAMAT_POOL>` dengan alamat sebenarnya:

```json
{
  "pool_overrides": {
    "<ALAMAT_POOL>": {
      "indicator_exit": { "timeframe": "5m" },
      "oor_exit": { "below": { "trigger_bins": 28 } }
    }
  }
}
```

Melalui Telegram: `/config set pool_overrides.<ALAMAT_POOL>.oor_exit.below.trigger_bins 28`. Override belum memiliki menu tombol tersendiri. `/tf` tidak mengubah override pool.

### `execution`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `priority_fee.mode` | `"fixed"` | Hanya biaya prioritas tetap yang didukung. | F |
| `priority_fee.microlamports` | `100000` | Harga prioritas per compute unit, dalam micro-lamport; integer ≥ 0 dan ≤ cap. Bukan total biaya transaksi. | T |
| `priority_fee.max_cap_microlamports` | `500000` | Batas harga prioritas per compute unit; integer ≥ nilai di atas. | T |
| `max_retries` | `3` | Batas total percobaan close LIVE; integer 1–3, DRY-RUN satu percobaan. Status broadcast tidak pasti tidak diulang otomatis. | T |

Satu lamport = 1.000.000 micro-lamport; satu SOL = 1.000.000.000 lamport. Total biaya bergantung pada compute-unit limit dan biaya jaringan.

### `swap`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `enabled` | `true` | Swap token hasil close ke SOL; memerlukan API key Jupiter. | T |
| `output` | `"SOL"` | Hanya output SOL didukung. | F |
| `min_value_usd` | `0.5` | Nilai minimum token untuk swap; angka ≥ 0 USD. | T |
| `slippage_bps` | `500` | Slippage awal; integer ≥ 1 bps, `500 bps = 5%`. | T |
| `max_slippage_bps` | `1500` | Cap slippage; integer ≥ slippage awal dan ≤ 10000; default 15%. Retry menaikkan 250 bps per percobaan hingga cap. | T |
| `max_retries` | `3` | Batas total percobaan swap; integer 1–3. | T |
| `close_empty_token_account` | `false` | Penutupan akun token kosong belum tersedia; `true` ditolak. | F |

### `top_trending`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `enabled` | `true` | Aktifkan fitur ranking baca-saja; memerlukan API key Jupiter. | T |
| `limit` | `10` | Jumlah hasil; integer 1–100. | T |
| `min_market_cap_usd` | `500000` | Minimum kapitalisasi pasar, angka ≥ 0 USD. | T |
| `min_token_age_hours` | `6` | Umur token minimum, angka ≥ 0 jam. | T |
| `max_token_age_days` | `60` | Umur token maksimum, angka ≥ 0 hari; tidak boleh di bawah umur minimum. | T |
| `min_holders` | `1000` | Minimum holder; integer ≥ 0. | T |
| `min_tvl_usd` | `10000` | Minimum TVL pool, angka ≥ 0 USD. | T |
| `min_organic_score` | `70` | Minimum Organic Score, angka 0–100. | T |
| `volume_window` | `"24h"` | Urut volume `4h`, `12h`, atau `24h`; tidak tersedia pilihan `6h`. | T |

Hasil menggunakan pool token/SOL; fitur ini tidak membuka posisi atau menjalankan transaksi.

### `jupiter`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `base_url` | `"https://api.jup.ag/swap/v2"` | Endpoint build swap; wajib HTTPS pada host `api.jup.ag`. | F |
| `tokens_base_url` | `"https://api.jup.ag/tokens/v2"` | Endpoint metadata token; host yang sama. | F |
| `price_base_url` | `"https://api.jup.ag/price/v3"` | Endpoint harga; opsional, kode memakai URL ini jika field tidak ada. | F |

### `notify`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `profit_alert.enabled` | `true` | Aktifkan pengingat profit berulang; tanpa close/swap. | T |
| `profit_alert.interval_minutes` | `5` | Interval pemeriksaan pengingat; integer ≥ 1 menit, ketelitian mengikuti siklus 60 detik. | T |
| `profit_alert.threshold_percent` | `5` | Ambang profit, angka ≥ 0%; persentase harus **lebih besar**, bukan sama dengan ambang. | T |
| `low_sol_balance_alert_sol` | `0.05` | Peringatan bila saldo SOL wallet di bawah ambang; angka ≥ 0 SOL. | T |
| `heartbeat.enabled` | `false` | Aktifkan ringkasan harian. | T+R |
| `heartbeat.at_time` | `"08:00"` | Jadwal harian `HH:mm` sesuai `timezone`. | T+R |

### `history`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `enabled` | `true` | Jurnal wajib aktif; `false` ditolak oleh parser, bukan toggle runtime. | F |
| `record_dry_run_trades` | `true` | Wajib `true` dalam DRY-RUN; belum menjadi toggle pencatatan runtime. | Belum aktif |
| `snapshot_interval_sec` | `300` | Interval snapshot posisi on-chain; integer ≥ 1 detik. | T+R |
| `snapshot_retention_days` | `180` | Retensi snapshot posisi; integer ≥ 1 hari. | T |
| `candle_audit_retention_days` | `60` | Retensi baris candle; integer ≥ 1 hari. Saat ini tidak menghapus tabel sinyal/audit. | F |
| `context_candles` | `50` | Jumlah candle konteks jurnal exit; integer ≥ 1. | T |
| `post_exit_marks_min` | `[15,60,240,1440]` | Offset pemantauan harga setelah exit, dalam menit; setiap elemen integer > 0. | F |
| `csv_export.enabled` | `true` | Export CSV otomatis; `/export` tetap tersedia untuk permintaan manual. | T |
| `csv_export.dir` | `"./exports"` | Direktori export; harus berada di dalam direktori proyek. | F |
| `csv_export.file` | `"trades.csv"` | Nama file `.csv` biasa, tanpa path direktori. | F |
| `backup.enabled` | `true` | Aktifkan backup database harian. | T+R |
| `backup.dir` | `"./backups"` | Direktori backup; harus berada di dalam direktori proyek. | F |
| `backup.at_time` | `"03:00"` | Jadwal backup `HH:mm` sesuai `timezone`. | T+R |
| `backup.keep` | `14` | Jumlah backup yang dipertahankan; integer ≥ 1. | T+R |

Data harga setelah exit memerlukan harga exit USD yang tersedia dan seri candle USD; hasil bisa berstatus tidak tersedia. Pembersihan retensi berjalan berkala, bukan tepat saat nilai konfigurasi diubah.

### `logging`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `level` | `"info"` | String yang divalidasi; belum mengatur penyaringan log runtime yang memakai `console`. | Belum aktif |

## Keamanan dan mode LIVE

- Simpan credential di `.env`, bukan di URL konfigurasi, Telegram, atau commit Git. `.env` dan konfigurasi diperketat ke permission `600` saat startup; keypair juga wajib `600` dan berada di luar repository.
- Untuk LIVE, atur `AGENT_KEYPAIR_PATH`, restart, kirim `/golive`, lalu tekan tombol konfirmasi. Signer harus cocok dengan `AGENT_WALLET_PUBKEY`; tersedia waktu konfirmasi dua menit.
- Mode tersimpan di SQLite dan dapat tetap LIVE setelah restart meskipun file contoh memakai `dry_run: true`. Selalu periksa `/status`; tidak ada command `/godryrun` saat ini.
- Close dan swap LIVE disimulasikan sebelum broadcast. Build Jupiter diperiksa terhadap mint, jumlah, slippage, router, signer, akun token milik wallet, dan cleanup wrapped SOL. Layout instruksi tidak didukung ditolak.
- Broadcast tidak pasti tidak diulang otomatis. Metadata saldo yang belum tersedia direkonsiliasi dengan status `WAITING_METADATA`; `/retryswap` menolak hasil sukses atau percobaan yang belum terselesaikan.
- Jurnal simulasi sebelumnya diarsipkan sebagai `DRY_RUN_ARCHIVED` ketika posisi masuk eksekusi LIVE. Mode DRY-RUN tidak menandatangani/mengirim transaksi, tetapi tetap melakukan request dan simulasi.

Detail arsitektur: [ARCHITECTURE.md](ARCHITECTURE.md). Persyaratan keamanan: [PRD_SECURITY.md](PRD_SECURITY.md). Panduan kontributor: [AGENTS.md](AGENTS.md).

## Batasan dan pemecahan masalah

| Gejala / batasan | Penjelasan dan tindakan |
| --- | --- |
| `Missing required environment variable` | Isi variabel wajib pada `.env`, lalu restart. API key Jupiter diperlukan jika swap atau trending aktif. |
| Bot tidak merespons | Periksa token, ID chat/pengirim, akses jaringan, dan `pm2 logs yolow`. Pastikan hanya satu instance melakukan polling. |
| Menu command tidak muncul | Registrasi menu memakai Telegram dan tidak menambah RPC Helius. Jika setup gagal, `/help` tetap tersedia; restart untuk mencoba lagi. Tombol menu native hanya dipasang pada chat pribadi. |
| Posisi baru belum terlihat | Discovery default 300 detik. Periksa wallet dan kegagalan pemindaian sebelum mengubah interval. |
| PnL kosong / refresh gagal | Indeks Meteora dapat tertinggal; cache lama dipertahankan dengan peringatan. Tidak ada fallback RPC untuk PnL. |
| Notifikasi profit tidak muncul | Harus ada PnL SOL positif dan persen **> ambang**, data fetch ≤ 2 menit tanpa error, fitur aktif, dan interval telah lewat. Tidak dikirim langsung saat startup. |
| Exit indikator berhenti | Periksa kecukupan/finalitas candle dan provider. Candle GMGN serta `onchain_ticks` belum terintegrasi; fallback berlanjut ke provider yang didukung. |
| Harga candle berbeda dari chart | Unit harga Meteora perlu dicocokkan dengan sumber chart sebelum mengandalkan exit LIVE; default tetap DRY-RUN. |
| HTTP 429 / penggunaan Helius tinggi | Jumlah pool, reconnect, snapshot, dan transaksi memengaruhi kuota. Default discovery/snapshot 300 detik mengurangi request; tidak menjamin batas kredit bulanan. GeckoTerminal diserialkan dan tetap dapat terkena cache/rate limit. |
| OOR terlambat saat feed terganggu | WebSocket dipakai untuk pool terpantau; fallback membaca satu akun pool per interval, default 15 detik. |
| ATH MarketCap `N/A` | API key GMGN atau data token yang cocok tidak tersedia. |
| Edit file tidak mengubah perilaku | Restart setelah edit file; nilai mode/timeframe di SQLite dan override pool dapat mengungguli nilai global. |
| Bot mati setelah reboot host | `pm2 save` bukan autostart; pasang startup service yang didukung atau jalankan `pm2 resurrect`. |

Struktur utama: `src/` untuk agent dan fitur, `test/` untuk pengujian, `data/` untuk SQLite, `exports/` dan `backups/` untuk hasil lokal. Jangan commit credential, keypair, database, export, atau backup.
