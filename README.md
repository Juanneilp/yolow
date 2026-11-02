# Yolow Agent

Bot Telegram untuk memantau posisi **Meteora DLMM** satu wallet Solana, screening pool token/SOL, serta simulasi entry, close, dan swap ke SOL.

**Otomatisasi hanya berjalan dalam DRY-RUN:** tidak menandatangani transaksi atau mengubah saldo nyata. Close simulasi atas posisi manual tidak menutup posisi di Meteora.

## Fitur utama

- **Posisi & PnL:** daftar posisi nyata/virtual, PnL SOL/%, status range, detail posisi, serta kontrol abaikan/aktifkan exit.
- **Top Careless:** screening pool token/SOL berdasarkan Simple Fee/TVL 24 jam, lalu volume. Filter awal: market cap ≥$1,5 juta, umur token ≥3 hari, TVL ≥$5.000.
- **Otomatisasi SPOT:** entry SOL saja, modal default **0,5 SOL**, range **−80% hingga 0%**, bin step ≥80. Maksimum **15 posisi**, termasuk posisi nyata dan virtual; entry ditolak jika biaya pembukaan non-refundable tidak terbukti nol.
- **Notifikasi:** posisi baru/hilang, entry/close simulasi, swap tertunda, dan pengingat profit. Default pengingat: setiap 5 menit untuk PnL **>5%**; pengingat tidak menjalankan close.
- **Jurnal:** riwayat trade, statistik, catatan/tag, dan export CSV. Status simulasi serta swap tertunda tersimpan dan dapat dilanjutkan setelah restart.
- **Blacklist:** blokir mint dari screening dan entry/reentry baru; posisi yang sudah terbuka tetap dipantau untuk exit.

## Menu Telegram

Mulai dengan `/start`, lalu buka `/menu`.

| Menu | Command | Fungsi |
| --- | --- | --- |
| 📊 Status | `/status` | Status bot, wallet, dan mode efektif. |
| 📍 Posisi & PnL | `/positions` | Posisi, PnL, detail, dan kontrol exit. `/pnl` adalah alias. |
| 🧪 Top Careless | `/topcareless` | Screening pool dan pengaturan filter. |
| 📒 Jurnal | `/history` | Riwayat, statistik, dan export CSV. |
| ⚙️ Pengaturan | `/config` | Konfigurasi, otomatisasi, serta kontrol mode. |
| 🧰 Bantuan | `/help` | Semua command beserta contoh penggunaan. |

Command tambahan yang sering dipakai:

- `/auto` — status otomatisasi, slot, saldo simulasi, dan mint yang diblokir setelah loss.
- `/auto unblock <mint>` — hapus blokir loss setelah swap tertunda selesai.
- `/ignore <position_id>` / `/unignore <position_id>` — abaikan/aktifkan exit posisi.
- `/blacklist add <CA>` / `/blacklist remove <CA>` — kelola blacklist manual. Daftar ini terpisah dari blokir loss.

## Trigger utama

Aturan berikut memakai nilai default dan berlaku untuk posisi virtual maupun simulasi atas posisi manual yang exit-nya aktif. Urutan tabel adalah **prioritas exit**.

| Prioritas | Trigger | Tindakan simulasi |
| --- | --- | --- |
| 1 | **OOR bawah ≥20 bin** | Close loss, swap seluruh saldo mint tersebut ke SOL, blokir mint, lalu cari token lain. |
| 2 | **PnL neto ≤−50% dari modal** | Close loss dengan tindakan yang sama. Modal 0,5 SOL berarti rugi neto ≥0,25 SOL. |
| 3 | **OOR atas ≥10 bin** | Close, lalu prioritaskan reopen pool yang sama jika masih memenuhi syarat entry, kapasitas, dan larangan duplikat/blacklist. |
| 4 | **Profit neto ≥5%** | Close, lalu pilih pengganti melalui screening. |

Jarak OOR dihitung dari **batas range**, mengikuti arah harga token terhadap SOL; orientasi SOL di X/Y diperhitungkan. Ini bukan persentase harga atau jumlah perpindahan bin kumulatif.

PnL neto untuk trigger memakai hasil likuidasi estimasi setelah slippage dan gas; rent refundable serta saldo token lama tidak dihitung sebagai profit posisi. PnL di daftar posisi berasal dari Meteora dan belum dikurangi gas/slippage likuidasi. Tanpa basis modal atau quote yang lengkap dan segar, take-profit/stop-loss PnL tidak terpicu; OOR tetap dapat berjalan.

Setelah loss, swap mencakup **seluruh saldo wallet untuk mint yang sama, termasuk saldo lama**. Exit lain hanya menukar token hasil posisi. Dust di bawah **$0,20** tetap token; swap gagal dicoba ulang tanpa mengulang close.

Pemeriksaan OOR berjalan setiap **15 detik**, memakai polling gabungan maksimal 100 pool per permintaan tanpa subscription akun WebSocket. Valuasi PnL mengikuti `automation.valuation_interval_sec`: contoh konfigurasi **180 detik**, sedangkan config lama tanpa field ini tetap **60 detik**. OOR tetap diperiksa di antara valuasi rutin, dengan refresh basis PnL yang kedaluwarsa sebelum menentukan prioritas stop-loss. Ambang −50% adalah pemicu, bukan jaminan kerugian akhir tepat −50%.

Profil hemat memakai snapshot jurnal setiap **900 detik** (`history.snapshot_interval_sec`), discovery setiap 300 detik, dan polling bin setiap 15 detik (`rpc.oor_fallback_poll_interval_sec`, nama lama dipertahankan). TP/SL dapat terlambat hingga interval valuasi ditambah waktu pemrosesan; snapshot lebih jarang membuat metrik historis kurang rinci.

Semua pemanggil HTTP RPC berbagi cooldown per key saat HTTP 429: 60, 120, 240, lalu maksimal 300 detik; `Retry-After` yang lebih lama tetap dihormati. Satu permintaan menguji pemulihan setelah cooldown. Retry 429 bawaan SDK dinonaktifkan. Ringkasan `Helius RPC usage` ditulis ke log per jam dan saat shutdown, berisi jumlah permintaan per metode, estimasi kredit (standar 1, `getProgramAccounts` 10), slot key, 429 dan permintaan yang ditunda. Ringkasan hanya mencakup proses berjalan; dashboard Helius adalah sumber tagihan sebenarnya.

## Dua key Helius dengan failover otomatis

Isi langsung di `.env` server (jangan commit nilainya):

```dotenv
HELIUS_API_KEY=key_utama
HELIUS_API_KEY_BACKUP=key_cadangan
```

Key cadangan opsional; nilai kosong atau sama dengan key utama tetap memakai satu key. Setelah mengisi atau mengganti `.env`, jalankan `pm2 restart yolow`. Tidak ada pengaturan key melalui Telegram atau `config.json`.

HTTP 429 dengan pesan kuota habis (`max usage reached`, limit kredit bulanan, atau kredit exhausted) memindahkan koneksi HTTP dan WebSocket konfirmasi LIVE ke key lain yang tersedia. Error 429 biasa, timeout, credential tidak valid dan error transaksi tidak mengganti key. Request baca/simulasi dapat diulang maksimal sekali pada key lain; broadcast transaksi tidak diulang otomatis. Key aktif dipertahankan selama berhasil dan slot 1/2 disimpan di SQLite (`helius_rpc_active_slot`), tanpa key atau asumsi tanggal reset kuota.

Konfirmasi LIVE yang sedang berjalan dibatalkan secara lokal dan dilanjutkan lewat koneksi baru dengan signature, commitment, blockhash dan batas kedaluwarsa yang sama. Konfirmasi mencoba setiap key maksimal sekali; kegagalan kembali ke rekonsiliasi PENDING/UNKNOWN. Strategi blockhash dipakai oleh semua pemanggil Yolow; API legacy signature-only tidak mendapat migrasi konfirmasi. Subscription akun pool tetap tidak dipakai.

Jika kedua key habis, cooldown per key tetap berlaku dan hanya satu recovery probe diizinkan pada setiap key. Log hanya menyebut slot key dan ringkasan penggunaan; kedua secret disamarkan. Dua key bukan jaminan durasi satu bulan: pemakaian serta reset kredit masing-masing akun tetap menentukan.

## Konfigurasi dan dokumentasi

Otomatisasi awalnya nonaktif. Aktifkan melalui `/config set automation.enabled true` hanya dalam DRY-RUN. Ambang dapat diubah melalui Pengaturan: `automation.oor_above_bins`, `automation.oor_below_bins`, `automation.stop_loss_percent`, dan `automation.profit_percent`. Interval valuasi dapat diubah langsung tanpa restart dengan `/config set automation.valuation_interval_sec 180` (bilangan bulat aman minimal 15). LIVE ditolak selama otomatisasi aktif.

- [Contoh konfigurasi](config.example.json) dan [template environment](.env.example).
- [Persyaratan fitur](PRD.md), [arsitektur](ARCHITECTURE.md), dan [desain Telegram](DESIGN_SYSTEM.md).
- [Keamanan](PRD_SECURITY.md) dan [panduan pengembangan/runtime](AGENTS.md).
