# PRD Keamanan Yolow untuk Swap dan Posisi Meteora DLMM

Versi 1.1 · Diperbarui 14 Oktober 2026 · Berdasarkan audit 13 Oktober 2026 · Status: SEC 01 sampai SEC 05 diterapkan pada kode dan diverifikasi lokal; SEC 06 dan SEC 07 masih usulan

## 1. Ringkasan

Yolow memantau posisi Meteora DLMM milik satu wallet Solana, menutup posisi berdasarkan sinyal indikator atau kondisi out of range, lalu menukar token hasil close menjadi SOL melalui Jupiter. Proses ini memberi aplikasi akses signing yang dapat menggerakkan dana wallet.

Hasil audit menunjukkan lima masalah yang harus diperbaiki sebelum transaksi live: validasi isi instruksi Jupiter, retry swap, finalisasi hasil dry-run, pemulihan metadata transaksi, dan kesegaran candle. Perubahan mode operasi serta dependency juga memerlukan perbaikan.

Fitur membuka posisi DLMM belum tersedia pada kode yang diaudit. Persyaratan untuk fitur tersebut dijelaskan sebagai prasyarat pengembangan berikutnya. Target pembaca adalah pemilik wallet dan engineer yang mengimplementasikan perbaikan.

### Status implementasi SEC 01 sampai SEC 05

| Persyaratan | Implementasi pada 14 Oktober 2026 |
|---|---|
| SEC 01 | Decoder empat instruksi exact-in dari snapshot IDL on-chain; pemeriksaan jumlah, mint, slippage, ATA, setup, cleanup, serta akses akun token wallet |
| SEC 02 | Retry memeriksa percobaan terbaru, transaksi belum selesai, kelengkapan catatan input, dan sisa hasil close terkonfirmasi; pencatatan swap sebelum broadcast dilakukan atomik |
| SEC 03 | Journal simulasi dan konteksnya disimpan sebagai event `DRY_RUN_ARCHIVED` sebelum journal aktif dipromosikan ke live |
| SEC 04 | Metadata belum tersedia menghasilkan `WAITING_METADATA`; recovery membaca hasil tanpa broadcast ulang dan mencatat hasil serta fee swap secara atomik |
| SEC 05 | Kesegaran diperiksa saat pemilihan provider, evaluasi indikator, dan sebelum broadcast; batas umur memperhitungkan interval candle, grace provider, dan stale allowance |

Regression test berada di `test/execution-security.test.ts`, termasuk fixture build dari API Jupiter dengan wallet dan ATA diganti untuk menghilangkan identitas wallet operasional. Pengambilan IDL dan build bersifat baca saja. Verifikasi ini belum mencakup pengiriman transaksi mainnet maupun pengaktifan kode melalui restart PM2.

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

## 4. Temuan dan persyaratan perbaikan

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

### SEC 05 Kesegaran candle sebelum exit indikator

**Prioritas: High, wajib sebelum live.** Sumber: [candles.ts](src/market-data/candles.ts), fungsi `fetchProvider`; [agent.ts](src/agent.ts), evaluasi indikator.

Provider saat ini memeriksa bahwa candle sudah selesai, tetapi belum memastikan candle terbaru cukup segar. Reproduksi lokal menunjukkan respons dengan candle berumur lebih dari 24 jam diterima sebagai seri sukses. Posisi lama yang memenuhi syarat umur dapat dievaluasi menggunakan data tersebut.

**Persyaratan:**

- Periksa kesegaran berdasarkan waktu akhir candle terbaru terhadap waktu saat ini. Umur maksimum adalah durasi timeframe dalam detik + `candles.grace_window_sec` + `candles.stale_data_pause_sec`, sehingga candle tetap berlaku sampai interval berikutnya beserta toleransi provider.
- Tolak seri kedaluwarsa dan coba provider berikutnya; respons HTTP sukses tidak boleh dianggap sebagai pemulihan data ketika candle masih lama.
- Periksa kembali kesegaran sebelum mengeksekusi sinyal indikator yang melewati antrean atau proses panjang.
- Jika semua provider kedaluwarsa, jeda exit indikator dan kirim status yang jelas; pemantauan OOR tetap mengikuti pengaman data active bin yang ada.

**Kriteria penerimaan:** candle selesai tetapi kedaluwarsa ditolak, fallback yang segar dapat digunakan, dan semua provider kedaluwarsa tidak menghasilkan close indikator. Sinyal yang menjadi kedaluwarsa sebelum eksekusi juga ditolak.

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

**Prioritas: Medium.** Sumber: [package.json](package.json), `package-lock.json`, serta hasil audit npm pada 13 Oktober 2026.

Audit melaporkan 14 paket terdampak advisory, dengan 6 high dan 8 moderate. Angka tersebut mencakup dampak transitif. `bn.js 5.2.2` terkena advisory infinite loop, sedangkan `bigint-buffer` terkena advisory buffer overflow. Keterjangkauan eksploit melalui Yolow belum dibuktikan.

**Persyaratan:**

- Perbarui `bn.js` ke versi patch kompatibel yang memperbaiki advisory dan pin versi terpilih pada manifest serta lockfile.
- Petakan penggunaan dependency transitif yang terdampak pada jalur SDK dan RPC; catat kondisi pemicu serta mitigasi untuk advisory yang belum memiliki perbaikan kompatibel.
- Evaluasi pembaruan atau penggantian dependency berdasarkan kompatibilitas SDK; hindari perubahan mayor otomatis melalui audit fix.
- Jalankan kembali test dan audit dependency setelah perubahan, serta dokumentasikan advisory yang masih tersisa.

**Kriteria penerimaan:** advisory direct dependency yang memiliki perbaikan kompatibel terselesaikan; dependency transitif yang masih terdampak memiliki penilaian jalur penggunaan dan keputusan mitigasi tertulis. Jumlah paket terdampak tidak boleh dipakai sebagai bukti bahwa semua advisory dapat dieksploitasi.

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

Audit ini mencakup kode aplikasi, metadata lokal yang relevan, test yang tersedia, reproduksi mock, dan advisory dependency. Transaksi mainnet nyata, file private key aktual, keamanan host secara menyeluruh, dan kontrak Meteora/Jupiter belum diperiksa. Kondisi dry-run dan jumlah advisory merupakan snapshot 13 Oktober 2026.

## 9. Referensi

- [PRD utama Yolow](PRD.md)
- [Arsitektur Yolow](ARCHITECTURE.md)
- [Jupiter Swap V2 Build](https://developers.jup.ag/docs/swap/build)
- [IDL instruksi Jupiter](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts)
- [Solana simulateTransaction](https://solana.com/id/docs/rpc/http/simulatetransaction)
- [Advisory bn.js GHSA-378v-28hj-76wf](https://github.com/advisories/GHSA-378v-28hj-76wf)
- [Advisory bigint-buffer GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
