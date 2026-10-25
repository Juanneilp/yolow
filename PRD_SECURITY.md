# PRD Keamanan Yolow untuk Swap dan Posisi Meteora DLMM

Versi 1.2 · Diperbarui 25 Oktober 2026 · SEC 01–05 diterapkan; patch kompatibel SEC 07 diterapkan dengan risiko transitif tersisa; SEC 06 masih usulan.

## 1. Ringkasan

Yolow memantau posisi Meteora DLMM milik satu wallet Solana, menutup posisi berdasarkan profit neto SOL atau kondisi out of range persentase, lalu menukar token hasil close menjadi SOL melalui Jupiter. Proses ini memberi aplikasi akses signing yang dapat menggerakkan dana wallet.

Audit 13 Oktober menemukan lima masalah pada validasi instruksi Jupiter, retry swap, finalisasi dry-run, pemulihan metadata transaksi dan kesegaran data. SEC 01–05 telah diperbaiki. Audit 25 Oktober menambahkan pemeriksaan runtime dan dependency; hasil terbaru dipisahkan dari reproduksi historis di bawah.

Pada audit awal, fitur membuka posisi DLMM belum tersedia. Rilis saat ini menambahkan entry virtual DRY-RUN, tanpa signer atau broadcast. Persyaratan untuk fitur tersebut dijelaskan sebagai prasyarat pengembangan berikutnya. Target pembaca adalah pemilik wallet dan engineer yang mengimplementasikan perbaikan.

### Status implementasi SEC 01 sampai SEC 05

| Persyaratan | Implementasi pada 14 Oktober 2026 |
|---|---|
| SEC 01 | Decoder empat instruksi exact-in dari snapshot IDL on-chain; pemeriksaan jumlah, mint, slippage, ATA, setup, cleanup, serta akses akun token wallet |
| SEC 02 | Retry memeriksa percobaan terbaru, transaksi belum selesai, kelengkapan catatan input, dan sisa hasil close terkonfirmasi; pencatatan swap sebelum broadcast dilakukan atomik |
| SEC 03 | Journal simulasi dan konteksnya disimpan sebagai event `DRY_RUN_ARCHIVED` sebelum journal aktif dipromosikan ke live |
| SEC 04 | Metadata belum tersedia menghasilkan `WAITING_METADATA`; recovery membaca hasil tanpa broadcast ulang dan mencatat hasil serta fee swap secara atomik |
| SEC 05 | Exit baru mensyaratkan snapshot harga/quote ≤120 detik dan memeriksa ulang sebelum perubahan state; executor menolak trigger lama dan snapshot kedaluwarsa sebelum broadcast |

Regression test berada di `test/execution-security.test.ts`, termasuk fixture build dari API Jupiter dengan wallet dan ATA diganti untuk menghilangkan identitas wallet operasional. Pengambilan IDL dan build bersifat baca saja. Verifikasi transaksi tetap menggunakan mock, tanpa pengiriman mainnet. Pemeriksaan runtime dan restart PM2 dicatat pada pembaruan 25 Oktober di bawah.

## 2. Tujuan dan cakupan

### Tujuan

- Semua transaksi yang ditandatangani harus sesuai wallet, mint, jumlah, penerima, dan tindakan yang dimaksud.
- Close dan swap tidak boleh dieksekusi ulang ketika transaksi sebelumnya berhasil atau belum diketahui hasilnya.
- Simulasi harus memungkinkan posisi yang sama dieksekusi ketika pengguna beralih ke live.
- Kegagalan provider harus menghasilkan status yang bisa dipulihkan tanpa mengarang jumlah hasil transaksi.
- Pengguna harus dapat kembali ke dry-run melalui Telegram, dengan pengaman yang berlaku pada semua jalur transaksi.

### Cakupan

Perbaikan mencakup executor close dan swap, retry manual, rekonsiliasi setelah restart, sumber candle, kontrol mode Telegram, journal SQLite, serta dependency yang digunakan pada jalur tersebut.

Asumsi operasional adalah satu proses Yolow, satu wallet, dan satu pengguna Telegram yang diizinkan. Pengamanan banyak proses dan banyak wallet memerlukan penilaian tambahan.

Pembukaan posisi DLMM menjadi tahap berikutnya setelah masalah eksekusi saat ini terselesaikan. Perubahan strategi trading, rebalancing, dashboard, serta audit kontrak Meteora dan Jupiter berada di luar cakupan perbaikan ini.

## 3. Kondisi saat audit

| Komponen | Kondisi pada 13 Oktober 2026 |
|---|---|
| Mode config dan SQLite | Keduanya menunjukkan dry-run |
| Transaksi live | Tabel `transactions` belum berisi transaksi |
| Close position | Tersedia melalui SDK Meteora |
| Swap | Tersedia melalui Jupiter Swap V2, token hasil close ke SOL |
| Open position | Belum tersedia |
| Slippage swap | Mulai 500 bps atau 5%, bertambah 250 bps per percobaan, maksimum 3 percobaan dan cap 1500 bps |
| Slippage efektif dengan konfigurasi tersebut | 5%, 7,5%, lalu 10% |
| Pengujian yang ada | `npm test` berhasil untuk kelima berkas test |
| Audit dependency npm | 14 paket terdampak, terdiri dari 6 high dan 8 moderate; termasuk dampak transitif |

Hasil test yang lulus belum mencakup seluruh skenario keamanan pada bagian berikutnya. Temuan lokal direproduksi dengan mock dan SQLite sementara tanpa transaksi mainnet.

### Pembaruan runtime dan dependency — 25 Oktober 2026

Audit sebelum patch: **15 paket terdampak (7 high, 8 moderate)**. Setelah instalasi bersih dari registry resmi: **13 paket (6 high, 7 moderate)**, tanpa temuan critical pada hasil npm saat pemeriksaan. Angka ini menghitung paket terdampak, termasuk transitif, bukan jumlah CVE unik atau bukti eksploitasi. Audit npm tidak menilai runtime Node.

| Temuan | Bukti dan tindakan |
| --- | --- |
| Node 22.23.2 tertinggal security release 21 Oktober | Naik ke **22.23.4** khusus Yolow, arsip resmi dan SHA-256 diverifikasi. Perbaikan mencakup Brotli CVE-2026-111497, DNS, TLS, HTTP, serta dependency bawaan. Yolow memakai fetch/SDK untuk respons jaringan; decompression dapat terjadi sebelum validasi JSON aplikasi. |
| Minimum Node lama menerima runtime rentan | Manifest menerima Node 22.x ≥22.23.4, `.nvmrc` mematok versi uji, engine-strict aktif. Import pemeriksaan runtime pertama pada entrypoint menolak versi lama/major lain sebelum konfigurasi JSON, database dan agent dimulai. |
| Tarball lockfile dari mirror HTTP | Semua URL tarball beralih ke `https://registry.npmjs.org/`, integrity tetap diverifikasi. Hash yang sudah dipercaya membatasi modifikasi artefak lama; HTTPS juga melindungi jalur unduh dan pembaruan metadata. |
| bn.js 5.2.2, CVE-2026-2739 | Patch **5.2.5**; regression test `maskn(0)` berjalan dalam subprocess dengan timeout agar kegagalan tidak menggantung suite. |
| body-parser 1.20.8, CVE-2026-111181 | Patch transitif **1.20.9** tanpa mengganti SDK/Express. Test proses terpisah memproses gzip dengan trailing bytes dan memastikan permintaan berikutnya dilayani. Tidak ditemukan server HTTP Yolow yang mengekspos middleware ini. |
| User root dan runtime bersama | User proses masih root. Node khusus Yolow tidak memperbarui Node global/daemon PM2/aplikasi lain; migrasi user khusus dan audit host terpisah tetap diperlukan. |

Advisori runtime dengan potensi RCE tidak membuktikan host ini telah disusupi. Tidak dilakukan eksploitasi pada proses operasional atau pemeriksaan private key.

#### Hasil validasi

- Instalasi bersih dari lockfile di staging: **109 tes lulus**, termasuk batas runtime, regresi dependency, validasi instruksi transaksi, otorisasi, retry/recovery dan simulasi. Tes memakai mock/SQLite sementara; tes body-parser hanya mendengarkan loopback.
- Pemeriksaan baca-saja menggunakan Node baru dan dependency baru berhasil membaca SQLite, bin/holding SDK Meteora serta quote Jupiter. Startup dengan Node 22.23.2 ditolak sebelum agent berjalan.
- Setelah penggantian dependency, proses Yolow direstart dan executable aktual `/proc/<pid>/exe` dikonfirmasi sebagai `.runtime/node/bin/node`, versi **22.23.4**. Startup DRY-RUN dan polling Telegram berhasil; jumlah transaksi tetap **0** saat verifikasi. Proses lain tidak direstart atau berganti interpreter.
- Konfigurasi interpreter Yolow disimpan untuk pemulihan PM2; konfigurasi operasional proses lain dibandingkan sebelum/sesudah dan tetap sama. Node global serta daemon PM2 tetap pada runtime sebelumnya.
- Audit akhir pada instalasi aktif tetap **13 paket terdampak: 6 high, 7 moderate**; bn.js dan body-parser tidak lagi tercantum. Hash integrity paket dengan versi yang tidak berubah tetap sama.
- Terlihat 43 peringatan RPC HTTP429 selama startup, tanpa kegagalan aplikasi yang tercatat pada jendela verifikasi. Startup akhirnya berhasil; ini bukan bukti kapasitas/rate limit jangka panjang telah terselesaikan.

#### Advisory transitif yang belum diperbaiki

| Paket / jalur | Penilaian jalur penggunaan dan keputusan |
| --- | --- |
| `bigint-buffer 1.1.5` melalui SPL Token → buffer-layout-utils | Advisory tidak memiliki versi patched. Binding native aktif pada host. Jalur layout yang diperiksa memakai u64/u128/u192/u256 dengan buffer tetap 8/16/24/32 byte; tidak ditemukan pemanggilan langsung aplikasi dengan panjang bebas. Ini membatasi jalur yang ditemukan, bukan bukti bahwa semua jalur SDK aman. Tetap **risiko high**, perlu penggantian/pembaruan upstream yang teruji. Jangan memakai downgrade SPL Token 0.1.8 yang disarankan audit otomatis. |
| `toml 3.0.0` melalui Anchor | Parser termuat, tetapi pemanggilan `parse()` yang ditemukan berada di getter workspace untuk `Anchor.toml` lokal; aplikasi tidak memakai workspace itu. Jangan menambahkan parsing TOML tak tepercaya. Patch memerlukan perpindahan major di luar rentang Anchor saat ini; tetap tercatat sebagai risiko high. |
| `stream-json 1.9.1` melalui jayson | Terdapat advisory DoS dan prototype pollution. Web3 memakai client JSON-RPC browser/HTTP, sedangkan parser stream berada di jalur TCP/TLS jayson yang tidak dipakai Yolow. Tidak ada modul stream-json dalam cache setelah impor SDK pada pemeriksaan. Jangan mengekspos parser tersebut; patch major harus diuji terpisah. |
| `uuid 8.3.2` melalui jayson | Advisory mengenai v3/v5/v6 dengan buffer output eksternal. Jalur jayson yang diperiksa memakai v4 tanpa buffer eksternal; ID paper memakai `node:crypto.randomUUID`. Pertahankan batas ini, catat advisory sampai dependency upstream kompatibel tersedia. |

Label high/moderate pada Meteora, Anchor, Solana dan jayson sebagian merupakan propagasi dari dependency di atas. Tidak memakai override lintas major, fork, atau monkey patch untuk menyembunyikan hasil audit.

#### Peninjauan batas kepercayaan aplikasi

- Otentikasi Telegram memeriksa chat dan pengirim sebelum dispatch command/callback; input config menolak prototype path dan secret. Endpoint API dipatok ke host HTTPS/WSS tepercaya, tanpa redirect atau credential di konfigurasi.
- Respons aplikasi memakai timeout dan batas byte `readJsonResponse`; batas ini tidak otomatis berlaku pada seluruh respons RPC internal SDK. Host sumber tepercaya tetap merupakan batas kepercayaan.
- Signer divalidasi terhadap owner, permission, lokasi di luar repo dan public key wallet; Jupiter exact-in diperiksa terhadap instruksi, akun, mint, jumlah dan slippage. Retry/metadata recovery serta dry-run memakai tes regresi yang ada.
- `.env`, `config.json` dan SQLite operasional ditemukan dengan mode600. Secret tidak dicetak; backup privat dibuat di luar Git. Tidak mengubah aturan trading, mode, posisi atau signer.

Rujukan: [Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4), [bn.js](https://github.com/advisories/GHSA-378v-28hj-76wf), [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828), [bigint-buffer](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg), [toml recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [toml prototype pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j), [stream-json prototype pollution](https://github.com/advisories/GHSA-mjw6-4jj6-33hc), [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

PHP mengumumkan dua RCE pada 21 Oktober dan pemberitahuan tambahan pada 23 Oktober; rujukan [PHP resmi](https://www.php.net/archive/2026.php). Yolow tidak menggunakan PHP dan executable PHP tidak ditemukan di PATH; hal ini tidak membuktikan seluruh host bebas instalasi PHP lain.

## 4. Temuan dan persyaratan perbaikan

Uraian masalah SEC 01–04 berikut adalah reproduksi **historis sebelum perbaikan**, bukan deskripsi kerentanan aktif. Status saat ini ada pada tabel implementasi dan pembaruan audit di atas.

### SEC 01 Validasi isi transaksi Jupiter

**Prioritas: High, wajib sebelum live.** Sumber: [executor.ts](src/execution/executor.ts), fungsi `jupiterTransactionInstructions` dan `processSwap`.

Validasi saat ini membatasi program Jupiter dan signer, tetapi belum mengikat isi instruksi ke mint sumber, jumlah input, dan penerima yang diharapkan. Quote JSON diperiksa terpisah dari instruksi yang akan ditandatangani. Reproduksi lokal menunjukkan validator menerima data instruksi sembarang dan akun writable eksternal; ini membuktikan celah validator, bukan keberhasilan pencurian on-chain.

Jika respons penyedia dikompromikan, quote dapat terlihat benar sementara instruksi menggerakkan jumlah atau mengirim hasil ke akun yang berbeda. Simulasi yang berhasil hanya menunjukkan transaksi dapat dijalankan; pemeriksaan tujuan transaksi tetap diperlukan.

**Persyaratan:**

- Decode instruksi swap yang didukung dan cocokkan jumlah input, mint, slippage, serta batas minimum output dengan tujuan swap.
- Verifikasi akun sumber dimiliki wallet agent dan menggunakan mint yang diharapkan; akun output SOL atau wrapped SOL harus mengembalikan hasil ke wallet agent.
- Validasi operasi setup dan cleanup, termasuk akun token yang dibuat atau ditutup; nama program yang diizinkan saja tidak cukup.
- Tolak instruksi atau format yang tidak didukung sebelum signing. Penolakan harus dicatat tanpa membocorkan secret.
- Pertahankan pembatasan signer, host HTTPS, redirect, ukuran respons, dan biaya transaksi yang sudah ada.

**Kriteria penerimaan:** perubahan jumlah pada instruksi dengan quote tetap benar, mint salah, penerima eksternal, setup atau cleanup tidak sesuai, dan format tidak dikenal semuanya ditolak sebelum signing atau broadcast. Fixture transaksi sah tetap berhasil divalidasi.

### SEC 02 Retry swap hanya untuk sisa hasil close

**Prioritas: High, wajib sebelum live.** Sumber: [executor.ts](src/execution/executor.ts), fungsi `retrySwap`; [commands.ts](src/telegram/commands.ts), command `/retryswap`.

Query retry mengambil riwayat `FAILED` atau `NO_ROUTE` tanpa memastikan percobaan berikutnya belum berhasil atau masih menunggu hasil. Reproduksi lokal mengonfirmasi retry tetap diizinkan ketika percobaan terbaru berstatus `CONFIRMED`, `PENDING`, maupun `UNKNOWN`.

Saldo token wallet dapat berasal dari posisi lain atau transfer baru. Mengulang jumlah kegagalan lama dapat menjual saldo tersebut setelah hasil close sebelumnya sudah terjual.

**Persyaratan:**

- Periksa percobaan terbaru dan semua transaksi swap yang belum terselesaikan untuk close terkait sebelum mengizinkan retry.
- Blokir retry pada transaksi `PENDING` atau `UNKNOWN`, serta setelah seluruh jumlah hasil close sudah terjual.
- Hitung sisa jumlah dari hasil close terkonfirmasi dikurangi input swap yang berhasil; batasi lagi dengan saldo token yang tersedia.
- Terapkan aturan yang sama pada retry manual dan recovery otomatis, dengan pengaman satu swap berjalan untuk posisi terkait.

**Kriteria penerimaan:** riwayat gagal diikuti sukses, pending, atau unknown tidak menghasilkan broadcast baru. Dua permintaan retry yang berdekatan tidak menghasilkan dua swap. Saldo tambahan wallet tidak memperbesar jatah hasil close yang boleh dijual.

### SEC 03 Hasil dry-run tidak memfinalisasi eksekusi live

**Prioritas: High, wajib sebelum live.** Sumber: [executor.ts](src/execution/executor.ts), fungsi `closePosition`; [db.ts](src/storage/db.ts), tabel `trade_history`.

Simulasi mengisi `finalized_at`. Setelah beralih ke live, pemeriksaan tersebut dapat mengembalikan `ALREADY_FINALIZED` meskipun posisi on-chain masih terbuka. Kondisi dry-run selesai, mode live aktif, dan posisi tetap `OPEN` berhasil direproduksi secara lokal.

**Persyaratan:**

- Hanya close live terkonfirmasi yang boleh menandai posisi selesai untuk tujuan eksekusi live.
- Pertahankan riwayat simulasi dengan identitas mode yang jelas agar catatan tersebut tidak menghalangi close live atau tercampur dengan hasil dana aktual.
- Tangani catatan dry-run yang sudah memiliki `finalized_at` saat perubahan diterapkan; jangan menghapus journal atau bukti transaksi live.

**Kriteria penerimaan:** posisi yang sudah disimulasikan tetap dapat ditutup setelah `/golive` ketika menerima sinyal yang memenuhi syarat. Close live yang sudah terkonfirmasi tetap tidak diulang. Riwayat simulasi tetap dapat ditelusuri.

### SEC 04 Metadata transaksi harus dapat dipulihkan

**Prioritas: High, wajib sebelum live.** Sumber: [executor.ts](src/execution/executor.ts), fungsi `transactionDeltas`, `closePosition`, dan rekonsiliasi transaksi.

Setelah lima percobaan membaca transaksi, metadata yang masih kosong menghasilkan delta token, SOL, dan fee bernilai nol. Pipeline close dapat mencatat `SKIPPED_NO_TOKEN` lalu memfinalisasi journal. Pemulihan berikutnya melewati trade yang sudah final.

Akibatnya, close dapat berhasil di blockchain tetapi token hasil close tetap berada di wallet tanpa proses swap yang seharusnya dijalankan.

**Persyaratan:**

- Bedakan metadata belum tersedia dari metadata valid yang benar-benar menunjukkan jumlah nol.
- Pertahankan transaksi terkonfirmasi dalam kondisi menunggu hasil balance sampai metadata berhasil dibaca.
- Jalankan pemulihan pembacaan metadata melalui rekonsiliasi yang ada; jangan mengirim ulang close untuk memperoleh metadata.
- Jangan memfinalisasi jumlah hasil, fee, atau status tidak ada token dari metadata yang kosong.
- Ketika metadata pulih, lanjutkan swap sesuai mode saat ini, pengaturan swap, dan aturan SEC 02.

**Kriteria penerimaan:** metadata kosong kemudian tersedia menghasilkan jumlah aktual dan paling banyak satu swap yang berhasil. Restart selama penantian tetap dapat memulihkan hasil. Metadata valid dengan delta nol boleh menghasilkan `SKIPPED_NO_TOKEN`.

### SEC 05 Kesegaran harga dan quote sebelum exit

Snapshot harga dan quote exit baru harus bertimestamp valid, tidak di masa depan, dan berumur maksimum 120 detik. Pemeriksaan diulang setelah pekerjaan asinkron sebelum commit. Active-bin feed dengan fallback terhenti tidak boleh menghasilkan sinyal baru. Executor menolak trigger lama (`RETIRED_TRIGGER`) dan harga kedaluwarsa (`STALE_PRICE`) sebelum broadcast. Candle historis tetap dapat dibaca untuk jurnal, tanpa memicu exit indikator.

**Kriteria penerimaan:** harga/quote kedaluwarsa tidak menghasilkan entry, close atau kredit swap; retry setelah restart melanjutkan hasil close sekali saja. Sinyal yang kedaluwarsa dalam antrean/simulasi ditolak sebelum broadcast.

### Pengaman otomatisasi DRY-RUN

- Entry dan exit otomatis hanya mengubah tabel paper/ledger; tidak mengimpor atau memanggil jalur signing/broadcast.
- Aktivasi membutuhkan config dan mode SQLite DRY-RUN; `/golive` beserta callback ditolak selama otomatisasi aktif.
- Maksimum 15 termasuk posisi manual/ignored dan reservasi; ulangi discovery sebelum commit entry. Mint/pool aktif tidak boleh ganda.
- Tolak biaya pembukaan non-refundable yang tidak nol atau tidak diketahui, termasuk bin array, bitmap, composition fee dan ekstensi token yang tidak didukung.
- Batas swap minimum $0,20 berlaku pada semua swap. Dust tidak membayar gas swap dan tidak dihitung SOL.
- **Pengecualian yang diotorisasi pengguna:** setelah loss OOR bawah, sweep seluruh saldo wallet untuk mint tersebut, termasuk saldo lama. Ledger/jurnal memisahkan hasil saldo lama dari profit LP. Pengaman lama yang membatasi swap hasil close tetap berlaku pada executor LIVE; sweep ini hanya simulasi.
- Blokir mint loss sampai manual unblock. Swap gagal tetap CLOSING; blokir tidak dapat dibuka saat sweep belum selesai. Reservation tanpa debit dibersihkan saat startup; OPEN/CLOSING/ledger tetap persisten.
- ID paper terpisah dari posisi nyata. Simulasi close tidak menandai posisi nyata CLOSED dan tidak membebaskan slot nyata.

### SEC 06 Kembali ke dry-run melalui Telegram

**Prioritas: Medium.** Sumber: [commands.ts](src/telegram/commands.ts), `/golive`; [main.ts](src/main.ts), pemilihan mode startup; [executor.ts](src/execution/executor.ts), `isDryRun`.

`/golive` tersedia, tetapi perintah untuk kembali ke dry-run belum tersedia. Nilai live di SQLite mengalahkan `mode.dry_run: true` pada config saat restart. Reproduksi lokal mengonfirmasi prioritas mode tersebut.

**Persyaratan yang diusulkan:**

- Tambahkan `/dryrun` untuk pengguna yang sudah diizinkan, simpan perubahan mode di SQLite, batalkan konfirmasi `/golive` yang masih aktif, dan lepaskan signer dari executor.
- Periksa mode dan ketersediaan signer sebelum signing serta segera sebelum broadcast pada close, swap, retry, dan recovery.
- Transaksi yang sudah dikirim tetap direkonsiliasi; perubahan mode menghentikan pengiriman berikutnya.
- `/status` harus menampilkan mode efektif dan menjelaskan bahwa SQLite menyimpan mode lintas restart. Live hanya diaktifkan kembali melalui proses `/golive` yang tervalidasi.

Persyaratan ini menambahkan command perubahan mode operasi. PRD utama sebelumnya menghapus `/pause` dan `/resume`; penambahan `/dryrun` merupakan usulan baru dari audit keamanan.

**Kriteria penerimaan:** setelah `/dryrun` selesai diproses, pekerjaan yang belum broadcast tidak mengirim transaksi, termasuk pekerjaan yang sebelumnya dimulai dalam live. Mode tetap dry-run setelah restart dan akses pengguna tidak sah ditolak.

### SEC 07 Penanganan advisory dependency

**Status 25 Oktober:** patch kompatibel bn.js dan body-parser serta runtime Node diterapkan. Audit turun dari 15 menjadi 13 paket terdampak. Rincian jalur, mitigasi dan advisory tersisa tercatat pada pembaruan audit di atas. Versi SDK tidak diubah; seluruh perubahan versi dan integrity diperiksa pada lockfile.

Pemeliharaan selanjutnya harus memakai registry HTTPS, instalasi lockfile yang bersih, audit sebelum/sesudah, dan tes regresi. Jangan menerapkan perubahan major otomatis melalui audit fix. Kriteria selesai untuk patch kompatibel adalah advisori target hilang tanpa perubahan perilaku transaksi; hal itu tidak berarti seluruh risiko transitif terselesaikan.

## 5. Pengaman yang harus dipertahankan

| Pengaman saat ini | Kebutuhan saat perbaikan |
|---|---|
| Telegram memeriksa chat ID dan sender ID | Terapkan pada command, callback, dan `/dryrun` |
| Keypair berada di luar repository, dengan pemeriksaan permission, pemilik file, dan public key | Tetap diwajibkan untuk live; secret tidak masuk log, Telegram, config, atau database |
| `.env`, config, dan database yang diperiksa memiliki permission `600` | Pertahankan pembatasan akses file sensitif |
| Close memeriksa pemilik posisi dan status ignore sebelum broadcast | Pertahankan pemeriksaan pada close dan retry close |
| Simulasi sebelum broadcast | Pertahankan simulasi bersama validasi tujuan transaksi |
| Pencatatan signature sebelum broadcast | Pertahankan agar restart dapat merekonsiliasi transaksi |
| `UNKNOWN` menghentikan retry otomatis | Terapkan juga pada retry manual sampai status terselesaikan |
| Pembatasan host, HTTPS, redirect, ukuran respons, dan redaksi error | Pertahankan pada seluruh request yang membawa credential |

## 6. Persyaratan keamanan untuk open position DLMM

Open position merupakan fitur mendatang. Implementasi harus memenuhi persyaratan berikut sebelum dapat diaktifkan dalam live.

- Ambil data pool dari chain dan verifikasi program Meteora, identitas pool, mint X dan Y, token program, serta owner posisi tujuan.
- Cocokkan jumlah deposit dan akun sumber dengan wallet agent. Pertahankan nominal token dalam unit terkecil berbentuk integer agar pembulatan tidak mengubah jumlah.
- Validasi range bin, strategi deposit, slippage, biaya, dan saldo SOL yang diperlukan untuk fee serta rent sebelum signing.
- Tinjau extension Token-2022 yang memengaruhi transfer, termasuk transfer fee dan transfer hook. Extension yang belum didukung harus ditolak dengan alasan jelas.
- Jika pembuatan posisi memerlukan signer posisi tambahan, hanya izinkan signer yang dibuat lokal untuk operasi tersebut; simpan kebutuhan pemulihan secara aman sebelum broadcast.
- Terapkan pengaman mode, simulasi, signature sebelum broadcast, status `PENDING/UNKNOWN`, serta pencegahan duplikasi yang sama dengan close dan swap.
- Jika operasi terdiri dari beberapa transaksi, simpan kemajuan setiap transaksi agar restart memulihkan langkah yang tersisa tanpa mengulang deposit yang sudah berhasil.
- Preview operasi harus menampilkan wallet, pool, kedua mint, nominal deposit, range bin, serta batas slippage dan biaya yang akan diotorisasi.

**Kriteria penerimaan:** pool atau mint tidak sesuai, owner salah, jumlah melampaui otorisasi, range invalid, extension tidak didukung, signer asing, dan saldo biaya tidak cukup semuanya ditolak. Timeout atau restart tidak menghasilkan posisi atau deposit ganda. Dry-run tidak mengirim transaksi open.

## 7. Pengujian dan syarat pengaktifan live

| Area | Skenario wajib | Hasil yang diterima |
|---|---|---|
| Jupiter | Quote benar dengan instruksi yang diubah | Ditolak sebelum signing |
| Retry | Gagal lama diikuti sukses, pending, atau unknown | Tidak ada broadcast baru |
| Jumlah swap | Saldo wallet bertambah dari sumber lain | Jatah swap tetap dibatasi sisa hasil close |
| Dry-run ke live | Simulasi final tetapi posisi masih terbuka | Close live tetap dapat diproses |
| Metadata | Transaksi terkonfirmasi, hasil RPC sementara kosong | Menunggu dan pulih tanpa close ulang |
| Candle | Provider mengembalikan candle lama dengan HTTP sukses | Fallback atau jeda indikator |
| Mode | Beralih dry-run ketika transaksi sedang disiapkan | Pengiriman berikutnya dihentikan |
| Telegram | Chat benar tetapi sender salah, dan sebaliknya | Command serta callback ditolak |
| Restart | Transaksi sudah dikirim dan belum diketahui hasilnya | Rekonsiliasi tanpa pengiriman ulang |
| Open mendatang | Sebagian langkah berhasil sebelum timeout | Melanjutkan langkah tersisa tanpa deposit ganda |

SEC 01 sampai SEC 05 harus memiliki regression test yang gagal pada perilaku lama dan lulus setelah perbaikan. SEC 06 harus diuji sebelum command perubahan mode dirilis. Hasil SEC 07 harus dicatat setelah dependency diperbarui.

Pengaktifan live memerlukan penyelesaian SEC 01 sampai SEC 05, kontrol mode SEC 06, dan penilaian risiko dependency SEC 07. Verifikasi transaksi nyata dilakukan bertahap pada wallet operasional dengan dana terbatas; hasil harus dicocokkan dengan mint, saldo, signature, dan journal sebelum penggunaan rutin.

Status pemantauan minimum mencakup mode efektif, transaksi belum pasti, metadata belum tersedia, candle kedaluwarsa, kegagalan swap, serta sisa token hasil close. Perubahan mode dan penolakan transaksi harus tercatat tanpa secret.

## 8. Risiko dan batas audit

Wallet operasional sebaiknya hanya menampung dana yang dialokasikan ke bot. Permission file dan pembatasan Telegram tidak melindungi private key ketika proses atau host sudah dikompromikan.

Slippage 5%, 7,5%, dan 10% pada konfigurasi yang diaudit tetap memungkinkan hasil swap lebih rendah dari quote. Batas slippage juga tidak menjamin nilai token, ketersediaan rute, atau keamanan token. Kebijakan existing PRD untuk tetap mencoba swap tanpa veto price impact harus dipertahankan sambil mencatat dampaknya.

Audit ini mencakup kode aplikasi, metadata lokal yang relevan, test yang tersedia, reproduksi mock, dan advisory dependency. Transaksi mainnet nyata, file private key aktual, keamanan host secara menyeluruh, dan kontrak Meteora/Jupiter belum diperiksa. Snapshot historis 13 Oktober dipertahankan untuk konteks; kondisi runtime/dependency terbaru tercatat pada pembaruan 25 Oktober 2026. Eksploitasi advisory transitif belum dibuktikan melalui Yolow, dan audit host menyeluruh berada di luar cakupan.

## 9. Referensi

- [PRD utama Yolow](PRD.md)
- [Arsitektur Yolow](ARCHITECTURE.md)
- [Jupiter Swap V2 Build](https://developers.jup.ag/docs/swap/build)
- [IDL instruksi Jupiter](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts)
- [Solana simulateTransaction](https://solana.com/id/docs/rpc/http/simulatetransaction)
- [Advisory bn.js GHSA-378v-28hj-76wf](https://github.com/advisories/GHSA-378v-28hj-76wf)
- [Advisory bigint-buffer GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
