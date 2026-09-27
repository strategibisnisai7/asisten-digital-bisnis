# Telegram: adapter dan webhook lokal

Endpoint: `POST /api/telegram/webhook`. Runtime Node.js; hasil HTTP tidak berisi data inventory atau credentials. Telegram hanya menjadi interface: teks → Rule Parser → Inventory Engine → Google Sheets. Operasi tulis, pesanan, dan Gemini tidak dijalankan.

## File dan tanggung jawab

| File | Tanggung jawab |
| --- | --- |
| `app/api/telegram/webhook/route.ts` | Endpoint Next.js, runtime Node.js, batas durasi 60 detik |
| `lib/telegram/webhook.ts` | Verifikasi secret, validasi request, status HTTP aman |
| `lib/telegram/bot-service.ts` | `sendMessage` dan `answerCallbackQuery` dengan token server-side |
| `lib/telegram/adapter.ts` | Menghubungkan update Telegram dengan parser dan engine |
| `lib/telegram/formatting.ts` | Menu, detail barang, kandidat, dan pagination 8 barang/halaman |
| `lib/telegram/callbacks.ts` | Signature callback yang terikat chat, SKU/query, dan halaman |
| `lib/telegram/types.ts` | Tipe dan pembacaan subset payload update Telegram |
| `lib/telegram/config.ts` | Konfigurasi dan error yang tidak menyertakan credentials |
| `lib/parser/rule-parser.ts` | Tambahan `/start`, `/help`, `/menu`, dan empat label menu |
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

Kirim `/start` untuk menu:

- 🔍 Cek Stok → meminta nama barang/SKU.
- ⚠️ Stok Menipis → langsung menjalankan LOW_STOCK.
- 📋 Cari Barang → meminta nama barang/SKU.
- ❓ Bantuan → contoh perintah.

Nama/SKU yang diketik sesudah prompt tetap mengikuti parser tanpa sesi: nama polos menjadi SEARCH_PRODUCT, sedangkan `stok <nama>` menjadi CHECK_STOCK. Hasil tunggal keduanya menampilkan detail. Hasil ambigu menyediakan tombol SKU, disertai nama dan stok dalam daftar. Tombol SKU menjalankan CHECK_STOCK dengan pencocokan SKU eksak pada engine; data dibaca ulang saat diklik.

Stok menipis memakai hasil LOW_STOCK dari engine. Adapter hanya menyusun pesan dan membagi halaman, tanpa menghitung atau menyaring inventory lagi. Batas tiap halaman 8 barang; tombol Sebelumnya/Berikutnya memungkinkan semua hasil dibaca. Pesan memakai plain text agar nama barang yang mengandung HTML/Markdown tetap aman.

Callback menyimpan SKU pada label tombol dan query pencarian pada baris pertama pesan, dengan signature HMAC pada `callback_data`. Signature memvalidasi konteks tersebut sebelum dipakai. Payload callback tetap pendek walaupun SKU panjang; tidak ada sesi dalam memori yang hilang saat instance Vercel berganti. Perubahan secret membuat tombol lama tidak valid. Jika data berubah, pagination memakai daftar terbaru dan dapat bergeser.

## Test lokal tanpa URL publik

```bash
npm run test:all
npm run lint
npm run build
```

`test:telegram` memeriksa route, 7 alur teks, dan callback dengan data Sheets asli. Respons Telegram ditangkap oleh test; tidak mengirim pesan ke Telegram, tidak memanggil `setWebhook`, dan tidak membuat tunnel/URL publik. Unit test memakai fixture data dan transport pengganti.

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
