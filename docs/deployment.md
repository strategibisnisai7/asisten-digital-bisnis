# Persiapan GitHub dan Vercel

Project menggunakan Next.js App Router di root repository. Node.js ditetapkan ke `22.x` di `package.json`. `vercel.json` mendaftarkan Cron harian untuk notifikasi stok menipis.

## Credentials dan Git

`.gitignore` mengecualikan `.env*` (kecuali `.env.example`), file credentials JSON beserta backup, service-account JSON, direktori credentials/secrets, file private key, `node_modules`, `.next`, dan `.vercel`. `.env.example` hanya berisi nama variable dengan nilai kosong.

Gunakan pemeriksaan berikut sebelum membuat commit:

```bash
npm run check:secrets
```

Pemeriksa memindai file terlacak serta file baru yang tidak diabaikan Git. Ia membandingkan isinya dengan nilai secret lokal dan mencari pola token/key/JSON service account. Setelah staging, periksa isi blob Git yang benar-benar akan di-commit:

```bash
npm run check:secrets -- --staged
git diff --cached --check
```

Output hanya memuat jumlah file atau nama file bermasalah; tidak memuat nilai secret. Pemeriksaan pola membantu mendeteksi kebocoran tetapi bukan pengganti review file yang akan di-commit. Nama environment variable di source code adalah referensi konfigurasi, bukan nilai credentials.

## Pemeriksaan lokal

```bash
npm run test:all
npm run lint
npm run build
```

Test integrasi membutuhkan `.env` lokal. Test menangkap respons Telegram dan tidak mengirim pesan atau mendaftarkan webhook; `test:telegram` dapat membuat tab preferensi notifikasi jika belum ada. Build tidak membutuhkan pemanggilan Sheets/Telegram. Endpoint diagnostik `GET /api/test/sheets` mengembalikan 404 di production.

## Langkah pengguna: push ke GitHub

1. Buat repository GitHub kosong untuk project ini; jangan inisialisasi README baru bila sudah ada commit lokal.
2. Periksa `git status` dan commit lokal dengan `git log -1 --oneline`.
3. Sambungkan remote milik Anda, lalu push sendiri:

```bash
git remote add origin <URL-repository-GitHub-Anda>
git push -u origin main
```

Jika `origin` sudah tersedia, periksa remote tersebut terlebih dahulu dan jangan menimpanya tanpa memastikan tujuan repository. Jangan menaruh token GitHub di URL remote.

## Langkah pengguna: deployment Vercel

1. Impor repository GitHub di Vercel sebagai project Next.js, dengan root directory project ini.
2. Pilih Node.js 22.x. Gunakan install command `npm ci`, build command `npm run build`, dan output directory default Next.js.
3. Masukkan enam environment variable berikut melalui dashboard Vercel untuk environment Production:

   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_CLIENT_EMAIL`
   - `GOOGLE_SHEETS_PRIVATE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `CRON_SECRET` (acak, minimal 16 karakter; Vercel mengirimkannya sebagai Bearer token)

4. Salin nilai dari konfigurasi lokal secara pribadi. Untuk private key, gunakan PEM multiline atau string dengan escaped newline yang didukung service. Jangan beri prefix `NEXT_PUBLIC_` atau mengunggah file credentials JSON.
5. Pastikan service account memiliki izin **Editor** pada spreadsheet dan `TELEGRAM_STOCK_WRITE_ENABLED=true` hanya bila update/opname Telegram boleh disimpan.
6. Deploy setelah environment disimpan. Konfigurasi `vercel.json` menjalankan `GET /api/cron/low-stock` setiap hari pukul 01:00 UTC (08:00 WIB). Vercel Cron hanya aktif pada production.
7. Pendaftaran webhook adalah tindakan terpisah setelah deployment siap. Lihat [panduan Telegram](telegram.md) untuk body `setWebhook`, verifikasi akses endpoint, dan pengujian `/start`.

Pada tahap persiapan ini tidak ada push, deployment, pendaftaran webhook, atau perubahan data Sheets yang dijalankan. Logic otorisasi pengguna Telegram dan deduplikasi update masih mengikuti keterbatasan yang dijelaskan pada panduan Telegram.

Referensi: [Node.js di Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [environment Vercel](https://vercel.com/docs/environment-variables), dan [Next.js di Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs).
