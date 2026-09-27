# Telegram: adapter dan webhook lokal

Endpoint: `POST /api/telegram/webhook`. Runtime Node.js; hasil HTTP tidak berisi data inventory atau credentials. Telegram hanya menjadi interface: teks → Rule Parser → Inventory Engine → Google Sheets. Update stok ditulis ke Google Sheets hanya setelah konfirmasi dan hanya bila `TELEGRAM_STOCK_WRITE_ENABLED=true` (default nonaktif). Gemini tidak dijalankan; Hubungi Supplier hanya membuat tautan WhatsApp tanpa mengubah data.

## File dan tanggung jawab

| File | Tanggung jawab |
| --- | --- |
| `app/api/telegram/webhook/route.ts` | Endpoint Next.js, runtime Node.js, batas durasi 60 detik |
| `lib/telegram/webhook.ts` | Verifikasi secret, validasi request, status HTTP aman |
| `lib/telegram/bot-service.ts` | `sendMessage`, `sendDocument` (PDF), `answerCallbackQuery`, dan penghapusan tombol dengan token server-side |
| `lib/telegram/adapter.ts` | Routing update Telegram ke parser, engine, update stok, supplier, dan laporan; tidak berisi teks respons |
| `lib/telegram/formatting.ts` | Presentation layer terpusat: semua teks, menu, tombol, dan pagination 8 barang/halaman |
| `lib/telegram/callbacks.ts` | Signature callback yang terikat chat, SKU/query/halaman, dan segel ringkasan update stok |
| `lib/telegram/types.ts` | Tipe dan pembacaan subset payload update Telegram |
| `lib/telegram/config.ts` | Konfigurasi dan error yang tidak menyertakan credentials |
| `lib/parser/rule-parser.ts` | Perintah, label menu, variasi cek stok, update stok multi-barang, dan kebutuhan barang |
| `lib/inventory/stock-update.ts` | Resolusi, validasi, ringkasan, dan penerapan update stok |
| `lib/inventory/transaction-service.ts` | Satu-satunya jalur write stok: sel Stok + Riwayat Transaksi secara atomik; membaca riwayat |
| `lib/supplier/supplier-service.ts`, `lib/supplier/whatsapp.ts` | Data supplier, pengelompokan kebutuhan per supplier, deep link WhatsApp (hanya membaca) |
| `lib/report/report-service.ts`, `lib/report/pdf-generator.ts` | Data laporan bulan berjalan dan pembuatan satu PDF |
| `lib/config/app.ts`, `lib/time/jakarta.ts` | Nama perusahaan/asisten yang dapat dikonfigurasi dan waktu Asia/Jakarta |
| `lib/parser/intents.ts`, `lib/inventory/inventory-engine.ts` | Opsi `match: "exact_sku"` pada CHECK_STOCK untuk SKU yang dipilih |
| `tests/telegram.test.ts` | Test parser menu, formatter, adapter, callback, webhook, dan transport |
| `scripts/test-telegram-local.ts` | Integrasi lokal memakai Sheets asli dan transport Telegram pengganti |

`package.json` menambahkan `test:telegram` ke `test:all`. `.env.example` menyediakan nama konfigurasi baru; `.env` lokal tetap diabaikan Git.

## Environment

- `TELEGRAM_BOT_TOKEN`: token asli dari BotFather, hanya di server.
- `TELEGRAM_WEBHOOK_SECRET`: secret independen 32–256 karakter `[A-Za-z0-9_-]`. Secret acak sudah disiapkan di `.env` lokal tanpa ditampilkan.
- Ketiga `GOOGLE_SHEETS_*` tetap digunakan oleh service Sheets.

Jangan beri prefix `NEXT_PUBLIC_`. Jangan masukkan token dalam query URL aplikasi, log, atau chat. Header setiap request webhook wajib berisi `X-Telegram-Bot-Api-Secret-Token` yang cocok. Endpoint menolak request tanpa secret, termasuk di development.

## Alur pengguna

Kirim `/start` untuk sambutan dan menu utama (keyboard persisten):

- 🔍 Cek Stok / 📋 Cari Barang → meminta nama barang atau SKU, dengan contoh.
- 📝 Update Stok → pilihan Barang Masuk, Barang Keluar, Koreksi Stok, dan Kembali (lihat "Update stok" di bawah).
- 📊 Laporan → langsung membuat satu PDF laporan bulan berjalan (lihat "Laporan").
- ⚠️ Stok Menipis → daftar barang di bawah minimum beserta stok dan minimumnya.
- 📞 Hubungi Supplier → Pesan Barang, Lihat Supplier, Cari Barang, Kembali (lihat "Hubungi Supplier").
- ❓ Bantuan → contoh kalimat yang bisa langsung dicoba.

Pengguna tetap bisa langsung mengetik tanpa memilih menu. Variasi seperti "cek stok", "cek stock", "lihat stok", "stok minyak", "berapa stok minyak", "minyak tinggal berapa", dan "stok beras ada berapa" dipahami sebagai cek stok. Perintah tanpa nama barang membuka prompt yang sesuai.

Hasil pencarian:

- Satu hasil → detail langsung ("🔎 Ditemukan").
- Beberapa hasil → "🔎 Saya menemukan N barang untuk "…"" dengan tombol berlabel nama produk. SKU baru ditampilkan setelah produk dipilih; tombol membaca ulang data terbaru dengan pencocokan SKU eksak.
- Tidak ada hasil → pesan ramah dengan tombol 📋 Cari Barang.
- Halaman hanya disebut bila hasil lebih dari 8 barang; navigasi memakai ◀️ Sebelumnya / Berikutnya ▶️.

Status stok memakai aturan engine: 🔴 Habis (stok 0), 🟡 Menipis (stok ≤ minimum), 🟢 Aman. Pesan memakai plain text agar nama barang yang mengandung HTML/Markdown tetap aman. Semua teks respons berada di `formatting.ts`.

Callback bersifat stateless dan ditandatangani HMAC: SKU disimpan di `callback_data` (fallback ke label tombol untuk SKU yang terlalu panjang), query pencarian di baris pertama pesan, dan ringkasan pesanan ditandatangani utuh. Tombol lama yang memakai SKU sebagai label tetap berfungsi. Perubahan secret membuat tombol lama tidak valid. Jika data berubah, pagination memakai daftar terbaru dan dapat bergeser.

Error teknis (Google API, jaringan) hanya dicatat di server log dalam bentuk yang sudah disanitasi. Pengguna menerima pesan "Maaf, saya sedang mengalami kendala saat mengambil data stok. Silakan coba lagi."

## Update stok

Contoh perintah (maksimal 20 barang per pesan; pisahkan dengan koma, titik koma, "dan", atau baris baru):

- Barang masuk: `tambah stok minyak 20, gula 30`, `minyak +20, gula +30`, `barang masuk: minyak 20, gula 30`
- Barang keluar: `keluar beras 10, minyak 5`, `minyak -5, gula -2`
- Koreksi (stok akhir yang benar): `koreksi stok minyak jadi 50, gula jadi 20`

Tombol 📥/📤/🔄 membuka prompt dengan kotak balasan (force reply); balasan berupa daftar saja (`minyak 20, gula 30`) dibaca sebagai jenis perubahan tersebut.

Alur: Parser → resolusi produk (SKU persis, nama persis, lalu sebagian) → validasi → ringkasan → konfirmasi → write. Tidak ada write sebelum konfirmasi, dan tidak ada write jika ada barang yang tidak ditemukan, ambigu, jumlah tidak valid, stok menjadi negatif, atau koreksi tanpa perubahan. Barang ambigu memunculkan tombol nama produk; setelah dipilih, permintaan dilanjutkan. Barang yang ditulis dua kali digabung (koreksi dengan dua target berbeda ditolak).

Ringkasan adalah transaksi tertunda (`PENDING_STOCK_UPDATE`): berisi SKU dan stok sebelum → sesudah, serta `Kode: UPD-<waktu>-<HMAC>` yang terikat ke chat dan isi ringkasan, berlaku 30 menit. Konfirmasi hanya lewat tombol ✅ pada ringkasan itu atau reply "ya" ke ringkasan itu; "ya" yang tidak me-reply ringkasan tidak menulis apa pun. Saat konfirmasi, stok dibaca ulang; jika berubah sejak ringkasan dibuat (termasuk konfirmasi kedua), tidak ada yang ditulis. Dua konfirmasi yang diproses pada saat yang persis sama belum diserialisasi karena tidak ada penyimpanan state bersama.

Semua write stok melewati `recordTransaction()` di `lib/inventory/transaction-service.ts`: sel Stok dan baris `Riwayat Transaksi` dikirim dalam **satu** request `spreadsheets.batchUpdate` yang diterapkan Google secara atomik, sehingga stok tidak pernah berubah tanpa riwayat. ADD menambah kolom E, REDUCE menambah kolom F, SET menambah `target − stok saat ini` ke kolom G. Kolom H (formula Stok Akhir) tidak pernah ditulis; setelah commit, H dibaca ulang untuk verifikasi.

Riwayat: satu baris per barang, satu ID per aksi (`TRX-001`, `TRX-002`, …), tanggal `dd/mm/yyyy` dan waktu `HH:mm` dibuat server dalam Asia/Jakarta, jenis `MASUK`/`KELUAR`/`KOREKSI`, dan user dari akun Telegram (`@username (id)`). Untuk SET, Quantity berisi selisih koreksi dan Keterangan `Koreksi ke <target>`.

**Penyimpanan dari Telegram default nonaktif.** Tanpa `TELEGRAM_STOCK_WRITE_ENABLED=true`, konfirmasi hanya memvalidasi ringkasan dan menjawab bahwa penyimpanan belum diaktifkan. Tab riwayat dibuat sekali dengan `npm run setup:transactions` (hanya membuat tab/header bila belum ada).

## Hubungi Supplier

Hanya membaca Sheets; tidak mengubah stok dan tidak membuat transaksi (`lib/supplier/supplier-service.ts`).

- **Pesan Barang**: balas prompt dengan `minyak goreng 20, gula 30`, atau ketik `butuh minyak 20 botol dan gula 30 kg`. Barang di-resolve, supplier dicari lewat Kode Supplier di `Master Barang` → tab `Supplier` (cadangan: nama supplier di tab Stok), lalu dikelompokkan per supplier. Setiap supplier mendapat tombol WhatsApp berupa deep link `https://wa.me/<nomor>?text=<pesan>`; pengguna mengirim sendiri. Tanpa nomor, ditampilkan "Kontak WhatsApp belum tersedia." dan tombol berbagi tanpa nomor. WhatsApp API tidak dipakai.
- **Lihat Supplier**: nama, kota, kontak, keterangan dari tab `Supplier`, dengan tombol WhatsApp bila nomor valid (dinormalisasi ke `62…`).

## Laporan

📊 Laporan langsung membuat laporan **bulan kalender berjalan** (Asia/Jakarta), tanpa input tanggal. Bot mengirim "📊 Sedang menyiapkan laporan bulan ini...", lalu "✅ Laporan bulan ini sudah selesai." (plus catatan bila belum ada transaksi), lalu **satu** PDF `laporan-stok-transaksi-YYYY-MM.pdf`. Jika gagal, pengguna hanya menerima pesan maaf; detail teknis masuk server log.

`lib/report/report-service.ts` membaca tab Stok dan Riwayat Transaksi, memfilter transaksi bulan berjalan, dan menghitung: ringkasan stok (aman/menipis/habis), barang masuk, barang keluar, pergerakan stok per barang (Stok Awal Periode dari "Stok Sebelum" transaksi pertama periode; Akhir = Awal + Masuk − Keluar + Adjustment), dan riwayat (terbaru dulu). Selisih antara histori dan stok saat ini dicantumkan sebagai catatan, tidak dikoreksi otomatis. Bagian Pembelian menyatakan belum ada data karena pembelian belum dicatat.

`lib/report/pdf-generator.ts` (pdf-lib, tanpa akses file sistem) membuat PDF A4 landscape: header perusahaan, nomor halaman, tanggal generate, tabel yang header-nya diulang di halaman baru, dan baris yang tidak terpotong. Font standar PDF tidak mendukung emoji, sehingga judul section memakai nomor dan karakter di luar Latin diganti.

Nama perusahaan dan asisten dapat diubah lewat `COMPANY_NAME` dan `ASSISTANT_NAME` (default PT Indah Merta Anugerah / Asisten Digital). Spreadsheet selalu dari `GOOGLE_SHEETS_SPREADSHEET_ID`.

## Test lokal tanpa URL publik

```bash
npm run test:all
npm run lint
npm run build
```

`test:telegram` memeriksa route, 10 alur teks, dan pilihan produk dengan data Sheets asli. Respons Telegram ditangkap oleh test; tidak mengirim pesan ke Telegram, tidak memanggil `setWebhook`, dan tidak membuat tunnel/URL publik. Unit test memakai fixture data dan transport pengganti.

Untuk smoke test HTTP pada `npm run dev`, kirim `POST` terautentikasi dengan JSON `{"update_id":1}`. Update ini tidak mengandung pesan dan hanya menguji respons `200 {"ok":true}`. Tanpa header secret, respons `401`. JSON rusak menghasilkan `400`; kegagalan pengiriman Telegram menghasilkan `503` tanpa detail sensitif.

Mengirim payload `message` terautentikasi ke endpoint asli akan memakai Bot API sungguhan. Gunakan `npm run test:telegram` untuk simulasi lengkap tanpa mengirim pesan. Token belum diuji ke Telegram dengan `getMe` atau pesan sungguhan pada tahap lokal ini.

## Deployment nanti ke Vercel

Langkah berikut belum dijalankan:

1. Simpan project di repository Git yang akan diimpor ke Vercel. Pastikan `.env` dan key JSON tidak ikut commit.
2. Di Vercel, buat project dari repository tersebut dan gunakan preset Next.js. Build command: `npm run build`.
3. Tambahkan tiga environment Google Sheets, `TELEGRAM_BOT_TOKEN`, dan `TELEGRAM_WEBHOOK_SECRET` melalui pengaturan environment Vercel untuk Production. Isi nilainya langsung di dashboard. Deploy/redeploy setelah konfigurasi disimpan.
4. Setelah deployment berhasil, Vercel menyediakan URL HTTPS. Gunakan domain production yang stabil, misalnya `https://nama-project.vercel.app`, bukan URL preview sementara. Endpoint nanti adalah `https://<domain-production>/api/telegram/webhook`.
5. Pastikan Telegram dapat mencapai endpoint tanpa halaman login Vercel Deployment Protection; autentikasi endpoint tetap memakai header secret Telegram. Endpoint test `/api/test/sheets` sudah dinonaktifkan pada production (404 sebelum membaca inventory).
6. Baru setelah URL siap dan pendaftaran diizinkan, panggil Bot API `setWebhook` menggunakan token dari environment dengan body `url` berisi endpoint production, `secret_token` berisi nilai `TELEGRAM_WEBHOOK_SECRET`, serta `allowed_updates: ["message", "callback_query"]`. Jangan memakai `drop_pending_updates: true` tanpa sengaja.
7. Periksa `getWebhookInfo`, lalu kirim `/start` ke bot untuk uji nyata. Jangan cetak URL Bot API lengkap atau objek error mentah karena dapat mengandung token.

Saat ini endpoint belum memiliki allowlist pengguna Telegram; setiap pengguna yang dapat menghubungi bot dapat meminta informasi stok. Secret webhook memverifikasi request dari integrasi Telegram, bukan otorisasi pengguna. Tetapkan kebijakan akses pengguna sebelum penggunaan inventory secara luas.

Pemrosesan dilakukan sebelum HTTP 200 dikembalikan; belum ada penyimpanan deduplikasi update yang persisten. Jika Telegram mengirim ulang update setelah timeout/kegagalan jaringan, balasan bisa terduplikasi. Semua operasinya tetap hanya membaca inventory.

Referensi: [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook), [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs), [URL deployment Vercel](https://vercel.com/docs/deployments/generated-urls), dan [Deployment Protection](https://vercel.com/docs/deployment-protection).
