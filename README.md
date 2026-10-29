# Yolow Agent

Yolow memantau posisi Meteora DLMM milik satu wallet Solana, menampilkan PnL per posisi, dan mengirim notifikasi ke satu chat Telegram yang diizinkan. Otomatisasi SPOT SOL mensimulasikan pembukaan dan penutupan berdasarkan profit neto SOL serta out-of-range (OOR) berdasarkan jarak bin. Exit RSI/BB/MACD dan engine OOR lama dengan timer/override telah dihapus. Mode awal instalasi baru adalah **DRY-RUN**: simulasi tanpa tanda tangan atau broadcast transaksi.

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

Pasang Git, **Node.js 22.x ≥ 22.23.4**, dan npm. `.nvmrc` mematok 22.23.4; major lain belum didukung dan ditolak saat startup. Versi ini memuat perbaikan keamanan 21 Oktober 2026. Siapkan bot Telegram beserta token dan ID chat, API key Helius, serta public key wallet yang akan dipantau. API key Jupiter diperlukan dengan konfigurasi bawaan karena swap dan Top Careless Strat aktif.

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

### Runtime terisolasi pada host bersama

Jika Node global masih lama atau dipakai aplikasi lain, pasang Node resmi khusus Yolow. Contoh berikut untuk **Linux x64**, dijalankan dari direktori repository. Untuk arsitektur lain, gunakan distribusi resmi yang sesuai; jangan menjalankan arsip x64.

```sh
(
  set -eu
  mkdir -p .runtime/downloads .runtime/node
  cd .runtime/downloads
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    https://nodejs.org/dist/v22.23.4/SHASUMS256.txt -o SHASUMS256.txt
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz -o node-v22.23.4-linux-x64.tar.xz
  rg '  node-v22\.23\.4-linux-x64\.tar\.xz$' SHASUMS256.txt | sha256sum --check --strict
  tar -xJf node-v22.23.4-linux-x64.tar.xz --strip-components=1 -C ../node
)
export PATH="$PWD/.runtime/node/bin:$PATH"
node --version
npm ci
```

Jalankan langkah ini sebelum `npm ci` bila Node global tidak memenuhi persyaratan. `.runtime/` diabaikan Git. PATH di atas hanya memengaruhi shell saat ini; terminal baru perlu mengaturnya kembali. Konfigurasi PM2 memilih `.runtime/node/bin/node` jika tersedia, lalu memakai `node` dari PATH sebagai fallback. Pemeriksaan startup tetap menolak runtime yang tidak didukung. Node global dan daemon PM2 tidak ikut diperbarui.

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
pm2 start ecosystem.config.cjs --only yolow
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

### Upgrade dan pemulihan

Sebelum upgrade, buat snapshot SQLite yang konsisten melalui backup SQLite/fitur backup Yolow, salin konfigurasi privat dengan permission `600`, dan simpan manifest serta lockfile sebelumnya di luar Git. Jangan menyalin hanya file database yang sedang aktif tanpa mempertimbangkan WAL.

Validasi dependency dan tes menggunakan Node terpilih di staging lebih dahulu. Saat mengganti runtime/dependency aktif, hentikan hanya Yolow bila diperlukan; jangan menimpa executable Node yang sedang dipakai. Untuk menerapkan perubahan interpreter pada proses yang sudah terdaftar:

```sh
pm2 restart ecosystem.config.cjs --only yolow
pm2 status yolow
pm2 logs yolow --lines 25 --nostream
```

Setelah konfigurasi interpreter terpasang, perubahan source biasa cukup `pm2 restart yolow`. Periksa **runtime proses**, bukan hanya `node --version` di shell: gunakan executable `/proc/<pid-yolow>/exe` di Linux atau kolom interpreter PM2, lalu jalankan executable tersebut dengan `--version`. Pastikan startup menyatakan DRY-RUN, polling Telegram berjalan, serta `/status` dan `/auto` sesuai. Jangan membagikan dump `pm2 env`/`pm2 jlist` karena dapat memuat credential.

Jika validasi aplikasi gagal, pulihkan source dan dependency yang kompatibel dari manifest/lockfile cadangan, tetap gunakan runtime yang sudah ditambal, lalu restart hanya Yolow. Pertahankan database dan mode SQLite; pemulihan database hanya untuk kerusakan data yang terkonfirmasi. Jangan mengatasi kegagalan dengan kembali ke Node yang rentan atau menonaktifkan pengaman dry-run.

## Penggunaan Telegram

Kirim `/menu` atau gunakan tombol **Menu**. Delapan command utama didaftarkan dengan deskripsi bahasa Indonesia: `/start`, `/menu`, `/status`, `/positions`, `/topcareless`, `/history`, `/config`, dan `/help`. Command lanjutan tetap bisa diketik; `/help` memuat daftar lengkap beserta contoh penggunaan. Kontrol memerlukan kecocokan **ID chat dan ID pengirim**.

Keyboard bawah menyediakan **🏠 Menu** dan **📍 Posisi & PnL** pada baris pertama, serta **🧪 Top Careless** pada baris kedua. Pintasan Posisi & PnL dan Top Careless membuka tampilan yang sama dengan `/positions` dan `/topcareless`. Kirim `/start` sekali setelah pembaruan untuk mengganti keyboard lama.

Menu utama memakai enam tombol:

| Baris | Kiri | Kanan |
| --- | --- | --- |
| 1 | 📊 Status | 📍 Posisi & PnL |
| 2 | 🧪 Top Careless | 📒 Jurnal |
| 3 | ⚙️ Pengaturan | 🧰 Bantuan |

**Jurnal** membuka riwayat dengan Refresh, Statistik, dan Export CSV, termasuk saat belum ada trade. **Pengaturan** memuat Otomatisasi, Live Mode dengan konfirmasi, dan bagian konfigurasi. `/auto` menampilkan status otomatisasi dan daftar token yang diblokir. Abaikan/Aktifkan exit tersedia di detail posisi. Bantuan mengelompokkan command menjadi Pemantauan, Screening, Jurnal, dan Pengaturan.

Fitur utama Yolow: pemantauan posisi dan estimasi PnL, simulasi entry/exit SPOT dan swap ke SOL, notifikasi profit/status, jurnal dan export, serta screening Top Careless.

Top Trending sudah dihapus. Command dan tombol lama menampilkan pemberitahuan penghapusan. Blok `top_trending` pada konfigurasi lama diabaikan dan tidak dapat diedit; konfigurasi lokal tidak ditulis ulang saat startup. Tidak diperlukan migrasi database. Restart bot untuk mendaftarkan daftar command terbaru.

| Command | Fungsi / nilai bawaan |
| --- | --- |
| `/start`, `/menu`, `/help` | Mulai, buka menu, atau lihat bantuan. |
| `/status` | Status wallet, proses, dan mode eksekusi efektif. |
| `/positions`, `/pnl` | Daftar gabungan Posisi & PnL; `/pnl` merupakan alias. |
| `/auto`, `/auto unblock <mint>` | Status simulasi dan hapus blokir token setelah loss. |
| `/ignore <position_id>`, `/unignore <position_id>` | Abaikan/aktifkan sinyal exit; pemantauan PnL tetap berjalan. |
| `/history [1–50]` | Riwayat trade; default 10 entri. |
| `/trade <trade_id\|position_id>` | Detail trade, swap, catatan, dan harga setelah exit. |
| `/stats [7d\|30d\|all]` | Statistik jurnal; default `all`. |
| `/note <trade_id\|position_id> <catatan>` | Simpan catatan trade. |
| `/tag <trade_id\|position_id> <tag>` | Tambahkan tag trade. |
| `/export` | Unduh jurnal CSV. |
| `/topcareless` | Screening Top Careless Strat: pool /SOL, urut Simple Fee/TVL 24 jam lalu volume 24 jam. |
| `/blacklist`, `/blacklist add <CA>`, `/blacklist remove <CA>` | Lihat, tambah, atau hapus blacklist mint untuk screening dan entry baru. |
| `/config`, `/config set <path> <nilai>` | Buka editor atau ubah parameter yang diizinkan. |
| `/retryswap <position_id>` | Minta retry swap dari hasil close terkonfirmasi yang masih tersisa. |
| `/golive` | Minta aktivasi LIVE; memerlukan keypair dan konfirmasi dalam dua menit. |

### Posisi, PnL, dan OOR

Daftar menampilkan **lima posisi per halaman**, diurutkan menurut PnL SOL terbesar. Setiap posisi memiliki PnL SOL/%, status range, status exit, dan waktu pengambilan data. Header menunjukkan cakupan data, misalnya `PnL terhitung 3/4`; data kosong tidak dianggap nol. Tombol **Detail** menampilkan deposit, penarikan, fee/reward, bin, ID lengkap, dan kontrol exit untuk posisi tersebut. Navigasi dan refresh mengedit pesan yang sama.

Persentase OOR adalah jarak harga dari batas range yang terlewati, mengikuti urutan bin DLMM. Contoh bin step 25 dan jarak 10 bin: **OOR atas 2,53%** atau **OOR bawah 2,47%**. Nilai dihitung secara majemuk dari bin aktif terakhir, bukan persentase untuk kembali ke range; bin step yang tidak tersedia membuat persentase tidak tersedia.

PnL berasal dari indeks Meteora sejak posisi dibuka, termasuk fee/reward menurut perhitungan penyedia; **belum dikurangi gas dan slippage likuidasi**. Angka ini terpisah dari PnL jurnal DRY-RUN/LIVE. Refresh latar belakang berjalan setiap 60 detik tanpa RPC Helius. Menu/Refresh memakai batas minimum 10 detik per pool; pagination/detail memakai cache normal. Fetch gagal mempertahankan data terakhir dengan peringatan, lalu menunggu minimal 60 detik atau sesuai `Retry-After`. Waktu saldo terakhir dari penyedia yang tidak berubah tidak otomatis berarti fetch gagal.

### Otomatisasi dry-run

Aktifkan `automation.enabled: true` hanya dengan mode efektif DRY-RUN. `/auto` menunjukkan slot nyata/virtual, perubahan saldo simulasi, swap tertunda, dan mint yang diblokir. Pengaturan awal instalasi baru tetap nonaktif agar aktivasi disengaja.

- Entry memakai SPOT **SOL saja**, modal **0,5 SOL**, TOKEN/SOL, bin step ≥80, range **−80% hingga 0%** dari entry. Orientasi SOL di X/Y ditangani dalam perhitungan harga dan distribusi.
- Screening mengikuti Top Careless: MCAP ≥**$1,5M**, umur ≥**3 hari**, TVL ≥**$5K**, urut Simple Fee/TVL lalu volume. Otomatisasi mempertahankan batas minimum ini walau filter tampilan diturunkan. Mint/pool aktif dan token loss dikeluarkan sebelum batas hasil.
- Entry ditolak bila biaya non-refundable tidak terbukti nol. Seluruh bin array dan bitmap diperiksa; composition fee, ekstensi token yang belum didukung ditolak. Gas jaringan diperbolehkan; rent posisi refundable dipisahkan dan dikembalikan dalam ledger close.
- Maksimum **15 posisi**, termasuk posisi manual di Meteora dan reservasi/posisi virtual. Close simulasi atas posisi manual **tidak membebaskan slot nyata**.
- Exit berlaku juga untuk posisi manual TOKEN/SOL, kecuali `/ignore`. Urutan prioritas: **OOR bawah ≥20 bin**, **OOR atas ≥10 bin**, lalu **profit neto ≥5% SOL**. Jarak bin dihitung dari batas range yang terlewati, bukan harga entry atau jumlah perpindahan kumulatif. Arah mengikuti harga token terhadap SOL, termasuk orientasi SOL di X/Y; pada SOL di X arah bin berbalik dari label range mentah di daftar posisi. Ambang tidak bergantung bin step. Profit memakai quote minimum setelah slippage dan estimasi gas entry/close/swap; rent dan saldo token wallet lama tidak dihitung sebagai profit.
- Setelah OOR atas, pool yang sama diprioritaskan hanya jika seluruh syarat dan larangan duplikat masih berlaku. Setelah profit, gunakan screening baru. Setelah loss, blokir mint dan cari token lain; gunakan `/auto unblock <mint>` untuk mengizinkannya kembali.
- Setelah loss, simulasi swap **seluruh saldo wallet mint tersebut**, termasuk saldo sebelum posisi ditutup. Bagian saldo lama dicatat terpisah dari profit LP. Setiap swap harus bernilai ≥**$0,20**; dust tetap token, tanpa gas swap dan tanpa kredit SOL. Route/quote gagal meninggalkan `CLOSING` untuk dicoba ulang, tanpa close atau kredit ganda.
- Pengamatan harga memakai WebSocket dengan fallback 15 detik; siklus exit 15 detik, valuasi profit 60 detik, screening entry 5 menit atau setelah close. Screening/quote entry dilewati bila slot penuh. Data/quote berumur >2 menit ditolak.

Posisi virtual, model bin, ledger, blokir mint dan status close disimpan di SQLite. Jurnal simulasi memakai ID `paper:<uuid>` terpisah; posisi nyata tetap OPEN. `/positions` membedakan nyata, virtual, dan close manual yang sudah disimulasikan.

Model virtual mengikuti likuiditas/fee bin yang terbaca; bin kosong memakai fill ideal pada harga bin. Ini estimasi tanpa dampak pasar atau fill mainnet, sehingga hasil tidak identik dengan posisi nyata. Profit posisi manual yang basis deposit/riwayatnya belum tersedia tidak memicu take-profit; OOR tetap dapat disimulasikan.

### Notifikasi profit

Default: ringkasan gabungan setiap **5 menit** ketika ada posisi terbuka dengan PnL SOL positif dan **PnL > 5%**; tepat 5% tidak memenuhi ambang. Pesan diulang selama masih ada posisi yang memenuhi syarat, termasuk posisi yang exit-nya diabaikan. Urutan berdasarkan persentase terbesar; ringkasan panjang dibagi menjadi pesan bernomor.

Pemeriksaan mengikuti siklus PnL 60 detik, pertama kali setelah satu interval dari refresh awal. Tidak ada notifikasi ketika data kosong, fetch gagal, atau hasil fetch berumur lebih dari dua menit. Refresh manual tidak memicu pesan. Restart memulai hitungan baru; tidak ada antrean pengiriman ulang atau pengiriman susulan untuk interval terlewat. Fitur ini tidak menjalankan close/swap.

### Kartu notifikasi

Semua notifikasi latar belakang memakai kartu HTML yang konsisten: judul dan pasangan token, mode **DRY-RUN/SIMULASI** atau **LIVE**, informasi utama, alamat yang bisa disalin, waktu lokal sesuai konfigurasi, serta tombol tindakan. Nama token menggunakan metadata yang sudah di-cache; bila belum tersedia, tampilkan mint singkat. Pengingat profit tetap mengikuti interval dan filter sebelumnya.

- **Posisi baru terdeteksi:** asal posisi nyata, status pemantauan, bin step/base fee dan range; tombol Detail posisi dan Buka Meteora.
- **Posisi tidak lagi di wallet:** pemantauan dihentikan setelah posisi tidak ditemukan pada pemindaian terbaru. Pesan ini tidak memastikan posisi sudah ditutup atau dijual.
- **Entry virtual:** modal SPOT SOL, range/bin step, non-refundable nol, rent refundable dan gas estimasi.
- **Close simulasi:** pesan dimulai dikirim setelah state close tersimpan, lalu pesan hasil akhir terpisah. Profit neto tetap estimasi; close simulasi atas posisi manual tidak menutup posisi nyata dan tidak membebaskan slot nyata.
- **Swap tertunda:** satu pemberitahuan, lalu retry otomatis tanpa close ulang. Penanda tersimpan di event simulasi agar restart tidak mengulang pesan menunggu. Setelah berhasil, kirim hasil akhir. Dust tidak dihitung sebagai SOL; hasil token wallet lama dipisahkan dari profit LP.
- **Saldo, error, pemulihan, backup/export dan ringkasan harian:** format sama dengan dampak dan tindakan berikutnya. Tombol menuju Pengaturan, Otomatisasi, Jurnal atau Posisi & PnL sesuai konteks.

SOL pada kartu memakai delapan angka desimal, persen dua, dengan koma desimal dan tanda profit/loss. Nilai sangat kecil memakai ambang `<...`, sedangkan data kosong ditulis **Belum tersedia**. Format angka ini untuk tampilan; perhitungan transaksi tetap dalam integer base units.

Pesan panjang dipecah menjadi bagian yang aman untuk HTML; tombol hanya pada bagian pertama. Label dan error disamarkan/di-escape, pratinjau tautan dinonaktifkan. Kegagalan Telegram tidak membatalkan pencatatan keuangan atau mengulang transaksi. Pengiriman bersifat best-effort tanpa jaminan pengiriman ulang selama gangguan jaringan; restart tidak memutar ulang notifikasi lama.

### Top Careless Strat

Buka **🧪 Top Careless** pada menu utama atau kirim `/topcareless`. Default menampilkan 10 pool **token/SOL** dengan market cap token **≥ $1.5M**, umur token **≥ 3 hari**, dan TVL **≥ $5.000**. Setiap pool menjadi entri sendiri, termasuk beberapa pool dari token yang sama; tidak ada filter holder, Organic Score, atau umur maksimum.

Blacklist manual memakai alamat mint Solana lengkap (CA), dengan huruf besar/kecil dipertahankan. Kirim `/blacklist add <CA>` untuk menambahkan, `/blacklist` untuk melihat daftar, dan `/blacklist remove <CA>` untuk menghapus. Satu command mengelola satu CA; nama/simbol token tidak diterima. Semua pool token blacklist dikeluarkan sebelum batas jumlah hasil, dan entry otomatis baru termasuk reentry ditolak. Posisi terbuka tetap dipantau dan exit tetap berjalan. Daftar disimpan di `top_careless.blacklisted_mints` pada `config.json` dan aktif langsung; Refresh `/topcareless` untuk memperbarui pesan lama. Konfigurasi lama mendapat daftar kosong tanpa migrasi database. `/auto unblock` hanya menghapus blokir loss; penghapusan blacklist juga tidak menghapus blokir loss. Format CA divalidasi secara lokal tanpa API; alamat tidak diverifikasi sebagai mint on-chain.

Urutan berdasarkan **Simple Fee/TVL 24 jam terbesar**, lalu **volume 24 jam terbesar**, lalu alamat pool untuk nilai yang sama. Estimasi fee = `Volume 24j × (Base fee % / 100)`; Simple Fee/TVL (%) = `Estimasi fee / TVL × 100`, atau langsung `Volume 24j × Base fee (%) / TVL`. Contoh: volume $100.000, base fee 0,3%, dan TVL $10.000 menghasilkan estimasi fee $300 dan Simple Fee/TVL **3,00%**. Base fee berasal dari `pool_config.base_fee_pct` API Meteora. Estimasi ini belum memperhitungkan dynamic fee atau potongan protokol.

Setiap kartu menampilkan base fee dan hasil Simple Fee/TVL 24 jam, serta APR dan Fee/TVL 24 jam dari API sebagai pembanding. APR diannualisasi satu kali dari persentase Fee/TVL 24 jam × 365, tanpa compounding atau farm reward. Data pembanding yang kosong atau tidak valid ditandai **Belum tersedia**. Kartu juga menampilkan market cap, umur, TVL, volume, bin step, CA dan alamat pool lengkap, serta link **Buka Meteora DLMM**. Ini screening baca-saja, bukan pembukaan posisi atau jaminan hasil LP.

Hasil memakai kartu berperingkat dengan Simple Fee/TVL sebagai angka utama. Header memisahkan jumlah hasil, filter aktif, dan waktu pembaruan beserta zona waktu. Tiga peringkat pertama memakai penanda medali; CA dan alamat pool tetap lengkap dan dapat disalin. Penjelasan estimasi tersedia pada bagian **Cara baca** di akhir hasil.

Setiap kartu juga menandai posisi aktif pada wallet:

```text
👛 Token: SUDAH ADA · 3 posisi di 2 pool
🏊 Pool ini: AKTIF · 2 posisi
```

Penanda token memakai alamat mint pada kedua sisi pasangan; penanda pool memakai alamat pool. Jika token aktif hanya di pool lain, token tetap **SUDAH ADA** tetapi pool ini **BELUM ADA**. Semua posisi nyata yang masih terbuka dihitung, termasuk yang exit-nya diabaikan atau close-nya baru disimulasikan. Posisi virtual dan posisi nyata yang sudah tertutup tidak dihitung. Penanda ini tidak menyaring hasil atau mengubah ranking.

Data posisi memakai sinkronisasi rutin wallet (default lima menit), tanpa tambahan RPC saat membuka atau Refresh screening. Header menampilkan waktu sinkronisasi wallet terakhir, terpisah dari pembaruan harga/hasil screening. Waktu ini disimpan bersama snapshot discovery, termasuk saat wallet kosong; feed bin aktif tidak memperbaruinya. Setelah kegagalan discovery, timestamp hilang/tidak valid, atau usia data melebihi dua interval polling (default sepuluh menit), kecocokan yang diketahui diberi label **data terakhir**; ketidakcocokan menjadi **BELUM TERVERIFIKASI**. Posisi manual yang baru dibuka/ditutup di Meteora dapat tertinggal hingga sinkronisasi berikutnya.

Umur token memakai `firstPool.createdAt` Jupiter, bukan umur pool DLMM. Kandidat tanpa data umur, market cap, volume, atau base fee yang valid dilewati; TVL harus positif. Base fee dan volume nol tetap valid. Pool dengan bin step kosong tetap ditampilkan dengan keterangan belum tersedia. Scan sumber maksimal 20 halaman × 100 pool dan tidak berhenti hanya karena jumlah hasil sudah terpenuhi. Urutan pengambilan API tetap Fee/TVL 24 jam lalu volume 24 jam; bot menghitung ranking akhir berdasarkan Simple Fee/TVL. Bila masih ada halaman setelah batas scan, pesan menjelaskan bahwa ranking hanya mencakup pool yang diperiksa, termasuk ketika hasil sudah penuh. Data baru diambil saat fitur dibuka atau **Refresh** ditekan, tanpa RPC Helius; scan yang lebih luas dapat memperlama respons. Daftar panjang dikirim sebagai beberapa pesan sesuai batas Telegram.

Setelah scan selesai, mint kandidat dideduplikasi lintas halaman dan metadata Jupiter diambil per maksimal 100 mint. Ranking dihitung setelah seluruh metadata berhasil diambil. HTTP 429 dicoba ulang maksimal dua kali, dengan total jeda retry maksimal lima detik per request. Waktu tunggu mengikuti `Retry-After` atau `x-ratelimit-reset` yang lebih akhir; tanpa header valid, jedanya satu lalu dua detik. Jika batas terlampaui, bot menampilkan error dan petunjuk Refresh serta mencatat error yang sudah disamarkan di log. Kegagalan API tidak ditampilkan sebagai hasil kosong atau ranking parsial.

Filter terpisah tersedia melalui **Filter** atau **Pengaturan → Top Careless Strat**; perubahan aktif tanpa restart:

```text
/config set top_careless.min_tvl_usd 5000
/config set top_careless.min_market_cap_usd 1500000
/config set top_careless.min_token_age_days 3
```

## Mengubah konfigurasi

Buka **Konfigurasi → bagian → parameter**. Boolean dan pilihan preset memakai tombol; angka, array, atau teks memakai **Ketik nilai**. Kirim `batal` untuk membatalkan. Perubahan divalidasi, disimpan secara atomik ke file, dan dicatat dalam audit SQLite.

```text
/config set notify.profit_alert.interval_minutes 10
/config set notify.profit_alert.threshold_percent 7.5
/config set notify.profit_alert.enabled false
/config set automation.oor_below_bins 20
/config set automation.enabled true
/config set candles.fallback_chain ["meteora","geckoterminal"]
```

**Legenda kolom Ubah:**

- **T**: bisa melalui Telegram, aktif tanpa restart.
- **T+R**: bisa melalui Telegram, perlu `pm2 restart yolow`.
- **F**: edit file, lalu restart; tidak tersedia melalui `/config set`.
- **Khusus**: memakai alur tersendiri, dijelaskan pada baris parameter.
- **Belum aktif**: nilai ada dalam konfigurasi, tetapi pengaruh runtime belum diterapkan.

Perubahan manual pada `.env` atau `config.json` selalu memerlukan restart. Mode efektif diwarisi dari SQLite; mengganti file tidak otomatis mengganti nilai tersebut. Periksa `/status` dan `/auto`.

## Referensi parameter

Kolom **Default** mengikuti file contoh yang disertakan repository, bukan konfigurasi pribadi yang sedang berjalan. Sebagian besar field wajib dicantumkan; jangan menganggap seluruh default otomatis diisi bila field dihapus. Parser secara eksplisit mengisi field `automation`, `top_careless` dan `notify.profit_alert` yang belum ada. `jupiter.price_base_url` bersifat opsional dengan fallback di kode.

Path parameter relatif terhadap judul kelompok: `enabled` di kelompok `automation` berarti `automation.enabled`.

### Parameter environment

Semua variabel disimpan di `.env`, diubah melalui file, dan dimuat saat startup.

| Parameter | Default / wajib | Fungsi |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Tanpa default; wajib | Token bot Telegram. |
| `TELEGRAM_CHAT_ID` | Tanpa default; wajib | ID numerik chat tujuan; ID grup dapat negatif. |
| `TELEGRAM_USER_ID` | Mengikuti `TELEGRAM_CHAT_ID` | ID numerik pengguna pengontrol; harus diisi untuk grup. |
| `HELIUS_API_KEY` | Tanpa default; wajib | Credential RPC HTTP dan WebSocket Helius. |
| `AGENT_WALLET_PUBKEY` | Tanpa default; wajib | Public key wallet yang dipantau. |
| `JUPITER_API_KEY` | Tanpa default; wajib jika swap/careless aktif | Akses Jupiter; label token bersifat opsional ketika fitur tersebut nonaktif. |
| `AGENT_KEYPAIR_PATH` | Kosong; wajib untuk LIVE | Lokasi keypair JSON di luar repository; harus cocok dengan wallet. |
| `DB_PATH` | `./data/yolow.db` | Lokasi database SQLite. |
| `CONFIG_PATH` | `./config.json` | Lokasi konfigurasi JSON. |

### Dasar dan `mode`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `config_version` | `1` | Versi format; hanya `1` didukung. | F |
| `timezone` | `"Asia/Jakarta"` | Zona waktu IANA untuk jadwal dan tampilan; beberapa label pesan masih tertulis WIB. | T+R |
| `mode.dry_run` | `true` | Mode awal bila belum ada nilai tersimpan di SQLite; LIVE memerlukan signer. | Khusus: `/golive` + konfirmasi |
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
| `grace_window_sec` | `60` | Jeda setelah penutupan candle sebelum dianggap final; integer ≥ 0 detik. | T |
| `backfill_candles` | `200` | Jumlah candle historis yang diminta/dipakai; integer ≥ 35. | T |
| `stale_data_pause_sec` | `300` | Batas kegagalan untuk peringatan data terhenti; juga bagian toleransi umur candle; integer ≥ 1 detik. | T |

Candle hanya dipakai untuk harga historis dan audit jurnal; tidak ada evaluasi indikator atau timer polling candle untuk exit.

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

### `automation`

| Parameter | Default | Batas / perilaku |
| --- | --- | --- |
| `enabled` | `false` | Aktifkan hanya dalam DRY-RUN, dengan swap aktif. |
| `max_positions` | `15` | Integer 1–15, termasuk semua posisi nyata/manual dan reservasi/posisi virtual. |
| `position_sol` | `0.5` | Modal SOL per entry; rent refundable dan gas tambahan. |
| `min_bin_step` | `80` | Integer ≥80. |
| `min_price_percent` | `-80` | Range SPOT dari persentase ini hingga 0%; dibulatkan ke bin terdekat di dalam batas, satu posisi extended. |
| `profit_percent` | `5` | Close jika profit neto SOL ≥ ambang. |
| `oor_above_bins` | `10` | Integer aman ≥1; close jika OOR atas mencapai jarak ini, lalu prioritaskan reopen pool sama jika tetap memenuhi syarat. |
| `oor_below_bins` | `20` | Integer aman ≥1; close loss jika OOR bawah mencapai jarak ini, swap seluruh saldo mint ke SOL, lalu blokir mint sampai diaktifkan manual. |

Semua parameter ini dapat diedit melalui Telegram tanpa restart. Parameter lama `automation.oor_above_percent` dan `automation.oor_below_percent` dibuang saat parsing; tanpa parameter bin baru, default menjadi 10/20 bin dan persentase lama tidak dikonversi. Posisi OPEN memakai ambang baru pada siklus berikutnya. Close CLOSING lama tetap menyelesaikan swap/reopen sesuai alasan aslinya, tanpa menulis ulang riwayat atau mengulang close. Blok lama `indicator_exit`, `oor_exit`, `pool_overrides`, `mode.shadow_candles`, polling candle, dan context candle dibuang oleh parser. `/tf` serta tombol lama hanya memberi pemberitahuan penghapusan.

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
| `min_value_usd` | `0.2` | Nilai minimum token untuk swap; angka ≥ 0,20 USD. | T |
| `slippage_bps` | `500` | Slippage awal; integer ≥ 1 bps, `500 bps = 5%`. | T |
| `max_slippage_bps` | `1500` | Cap slippage; integer ≥ slippage awal dan ≤ 10000; default 15%. Retry menaikkan 250 bps per percobaan hingga cap. | T |
| `max_retries` | `3` | Batas total percobaan swap; integer 1–3. | T |
| `close_empty_token_account` | `false` | Penutupan akun token kosong belum tersedia; `true` ditolak. | F |

### `top_careless`

| Parameter | Default | Fungsi dan batas nilai | Ubah |
| --- | --- | --- | --- |
| `enabled` | `true` | Aktifkan screening Top Careless Strat; memerlukan API key Jupiter. | T |
| `limit` | `10` | Jumlah pool hasil; integer 1–100. | T |
| `min_market_cap_usd` | `1500000` | Minimum market cap token; angka ≥ 0 USD. | T |
| `min_token_age_days` | `3` | Umur minimum berdasarkan first pool Jupiter; angka ≥ 0 hari. | T |
| `min_tvl_usd` | `5000` | Minimum TVL pool; angka ≥ 0 USD. | T |
| `blacklisted_mints` | `[]` | Daftar CA Solana yang dikecualikan dari screening dan entry otomatis baru; kelola dengan `/blacklist`. | T |

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
- Otomatisasi rilis ini hanya dry-run. `/golive` dan konfirmasinya ditolak saat otomatisasi aktif; startup juga menolak mode SQLite LIVE. Tidak ada implementasi entry LIVE.
- Untuk fitur eksekusi LIVE yang sudah ada, nonaktifkan otomatisasi lalu atur `AGENT_KEYPAIR_PATH`, restart, kirim `/golive`, lalu tekan tombol konfirmasi. Signer harus cocok dengan `AGENT_WALLET_PUBKEY`; tersedia waktu konfirmasi dua menit.
- Mode tersimpan di SQLite dan dapat tetap LIVE setelah restart meskipun file contoh memakai `dry_run: true`. Selalu periksa `/status`; tidak ada command `/godryrun` saat ini.
- Close dan swap LIVE disimulasikan sebelum broadcast. Build Jupiter diperiksa terhadap mint, jumlah, slippage, router, signer, akun token milik wallet, dan cleanup wrapped SOL. Layout instruksi tidak didukung ditolak.
- Broadcast tidak pasti tidak diulang otomatis. Metadata saldo yang belum tersedia direkonsiliasi dengan status `WAITING_METADATA`; `/retryswap` menolak hasil sukses atau percobaan yang belum terselesaikan.
- Jurnal simulasi sebelumnya diarsipkan sebagai `DRY_RUN_ARCHIVED` ketika posisi masuk eksekusi LIVE. Mode DRY-RUN tidak menandatangani/mengirim transaksi, tetapi tetap melakukan request dan simulasi.

Detail arsitektur: [ARCHITECTURE.md](ARCHITECTURE.md). Persyaratan keamanan: [PRD_SECURITY.md](PRD_SECURITY.md). Panduan kontributor: [AGENTS.md](AGENTS.md).

### Pemeliharaan keamanan dependency

Gunakan `.npmrc` repository: registry resmi `https://registry.npmjs.org/`, verifikasi integritas lockfile, dan pemeriksaan engine wajib. Jangan menonaktifkan TLS atau mengganti registry dengan mirror HTTP. Instalasi reproducible memakai `npm ci`; pembaruan dependency ditinjau melalui perubahan manifest dan lockfile.

```sh
npm audit --omit=dev
npm ls bn.js body-parser bigint-buffer toml stream-json uuid --all
npm test
```

Snapshot audit dan penilaian jalur eksploitasi tersedia di [PRD_SECURITY.md](PRD_SECURITY.md), dengan tanggal dan tautan advisori resmi. `npm audit` mencakup paket transitif; jumlah paket terdampak bukan jumlah celah unik ataupun bukti bahwa semua celah bisa dieksploitasi melalui Yolow. Jangan menjalankan `npm audit fix --force` atau menganggap audit npm memeriksa kerentanan runtime Node.

Patch kompatibel saat ini: `bn.js 5.2.5` dan `body-parser 1.20.9`. Beberapa advisory SDK tetap memerlukan penilaian/migrasi terpisah. Jalankan proses dengan user khusus tanpa root pada deployment baru; host saat ini masih root dan belum dimigrasikan. Patch Node khusus Yolow tidak menambal daemon PM2, Node global, atau aplikasi lain.

Advisori PHP 21 Oktober 2026 memang ada, tetapi Yolow tidak menjalankan PHP. Sistem lain yang menggunakan PHP perlu ditinjau terpisah. Rujukan: [Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [PHP security notices](https://www.php.net/archive/2026.php).

## Batasan dan pemecahan masalah

| Gejala / batasan | Penjelasan dan tindakan |
| --- | --- |
| Runtime ditolak / `EBADENGINE` | Gunakan Node 22.x ≥22.23.4; periksa PATH untuk npm dan interpreter aktual PM2. |
| `Missing required environment variable` | Isi variabel wajib pada `.env`, lalu restart. API key Jupiter diperlukan jika swap atau careless aktif. |
| Bot tidak merespons | Periksa token, ID chat/pengirim, akses jaringan, dan `pm2 logs yolow`. Pastikan hanya satu instance melakukan polling. |
| Menu command tidak muncul | Registrasi menu memakai Telegram dan tidak menambah RPC Helius. Jika setup gagal, `/help` tetap tersedia; restart untuk mencoba lagi. Tombol menu native hanya dipasang pada chat pribadi. |
| Posisi baru belum terlihat | Discovery default 300 detik. Periksa wallet dan kegagalan pemindaian sebelum mengubah interval. |
| PnL kosong / refresh gagal | Indeks Meteora dapat tertinggal; cache lama dipertahankan dengan peringatan. Tidak ada fallback RPC untuk PnL. |
| Notifikasi profit tidak muncul | Harus ada PnL SOL positif dan persen **> ambang**, data fetch ≤ 2 menit tanpa error, fitur aktif, dan interval telah lewat. Tidak dikirim langsung saat startup. |
| HTTP 429 / penggunaan Helius tinggi | Jumlah pool, reconnect, snapshot, dan transaksi memengaruhi kuota. Default discovery/snapshot 300 detik mengurangi request; tidak menjamin batas kredit bulanan. GeckoTerminal diserialkan dan tetap dapat terkena cache/rate limit. |
| OOR terlambat saat feed terganggu | WebSocket dipakai untuk pool terpantau; fallback membaca satu akun pool per interval, default 15 detik. |
| Edit file tidak mengubah perilaku | Restart setelah edit file; mode di SQLite dapat mengungguli mode dalam file. |
| Bot mati setelah reboot host | `pm2 save` bukan autostart; pasang startup service yang didukung atau jalankan `pm2 resurrect`. |

Struktur utama: `src/` untuk agent dan fitur, `test/` untuk pengujian, `data/` untuk SQLite, `exports/` dan `backups/` untuk hasil lokal. Jangan commit credential, keypair, database, export, atau backup.
