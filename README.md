# Stok? Tinggal Chat.

Target arsitektur: Telegram → Rule Parser → Gemini sebagai fallback → Structured Intent → Google Sheets → Telegram → wa.me.

Google Sheets adalah source of truth inventory. Tahap saat ini menyediakan Rule Parser, Inventory Engine untuk operasi baca, service Google Sheets, dan adapter/webhook Telegram untuk pengujian lokal. Webhook belum didaftarkan ke Telegram. Gemini, wa.me, dan operasi tulis belum diimplementasikan.

Panduan Telegram, test lokal, dan langkah deployment: [docs/telegram.md](docs/telegram.md).

Persiapan repository GitHub dan konfigurasi Vercel: [docs/deployment.md](docs/deployment.md). Runtime project ditetapkan ke Node.js 22.x.

## Konfigurasi Google Sheets

File `.env` lokal telah disiapkan dan diabaikan oleh Git. Untuk checkout baru, salin `.env.example` menjadi `.env` tanpa menimpa konfigurasi yang sudah ada.

1. Buat/pilih project Google Cloud dan aktifkan **Google Sheets API**.
2. Buat service account dan key JSON untuk aplikasi ini. Simpan key di tempat aman di luar repository.
3. Bagikan spreadsheet `1kmZOAUUd2Nx_xYQwBYHPwDWokgMH9WTCD1ENr8Px1ak` kepada email service account sebagai **Viewer**.
4. Isi `GOOGLE_SHEETS_CLIENT_EMAIL` dengan `client_email` dari JSON dan `GOOGLE_SHEETS_PRIVATE_KEY` dengan `private_key` dari JSON di `.env`. Isi `GOOGLE_SHEETS_SPREADSHEET_ID` dengan ID pada langkah 3; semua nilai dalam `.env.example` sengaja kosong.
5. Untuk private key, gunakan tanda kutip ganda dengan newline `\n` atau PEM multiline. Jangan kirim key lewat chat atau gunakan prefix `NEXT_PUBLIC_`.

Jika `.env.local` juga tersedia, nilainya mengalahkan `.env`; environment proses memiliki prioritas tertinggi. Restart development server sesudah perubahan konfigurasi.

## Service dan test

`lib/sheets/google-sheets.ts` menyediakan `readSheetRange(range)` menggunakan package `googleapis`. Credentials diambil dari tiga environment variable di atas melalui validasi server-side yang sudah ada. Service inventory `readStok()` menggunakan service ini juga.

Endpoint sementara `GET /api/test/sheets` membaca range tetap `Stok!A1:L5` dan mengembalikan JSON `{ range, majorDimension, values }` pada development. Response memakai `Cache-Control: no-store`. Error hanya berisi kode dan pesan aman; tidak ada objek credentials atau error mentah Google. Endpoint mengembalikan 404 pada `NODE_ENV=production`, termasuk deployment Vercel, sebelum mengakses Sheets.

Jalankan `npm run dev`, lalu buka `http://localhost:3000/api/test/sheets` untuk menguji koneksi. Endpoint hanya membaca spreadsheet.

`lib/google-sheets/service.ts` mengekspor `readStok()` untuk pemakaian di server Node.js (Server Component atau Route Handler). Modul dilindungi `server-only`; jangan impor ke Client Component atau Edge runtime. Konfigurasi dibaca saat fungsi dipanggil sehingga build tidak memerlukan credentials.

Service menggunakan scope `spreadsheets.readonly` dan membaca `'Stok'!A1:L` dengan `UNFORMATTED_VALUE`, sehingga angka dan hasil perhitungan rumus dibaca dari Sheets. Setiap pemanggilan membaca ulang sumber tanpa cache aplikasi. Tidak ada operasi tulis.

Header wajib berada pada baris 1 dengan urutan:

| A | B | C | D | E | F | G | H | I | J | K | L |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SKU | Nama Barang | Satuan | Stok Awal | Barang Masuk | Barang Keluar | Adjustment | Stok Akhir | Stok Minimum | Status Stok | Lokasi Rak | Supplier Utama |

Kolom H dibaca langsung dari spreadsheet, bukan dihitung ulang sebagai pengganti data sumber. Rumus baris 2 diharapkan `=D2+E2-F2+G2`. Kolom D–G kosong diperlakukan sebagai 0; I kosong menjadi `null`. Baris kosong, termasuk template dengan hanya rumus H/J, diabaikan. SKU duplikat, header tidak sesuai, angka tidak valid, serta H kosong/error menghasilkan error yang aman. Simpan SKU sebagai teks di Sheets jika memiliki nol di depan.

Sheet `Master Barang` dan `Supplier` belum dibaca karena struktur kolomnya belum ditentukan.

```bash
npm test             # Unit test tanpa credentials atau koneksi Google
npm run test:sheets  # Test integrasi baca spreadsheet asli; memerlukan .env
npm run test:inventory # Test engine terhadap spreadsheet asli; memerlukan .env
npm run test:telegram # Webhook/adapter lokal + Sheets asli; respons Telegram ditangkap test
npm run test:all      # Semua unit test dan ketiga test integrasi
npm run typecheck
npm run lint
npm run build
npm run check:secrets # Periksa kandidat file repository tanpa mencetak nilai secret
```

Test integrasi hanya mencetak jumlah barang dan hasil pemeriksaan formula; tidak mencetak credentials atau seluruh isi sheet. Exit code 1 berarti konfigurasi/koneksi/struktur/nilai formula bermasalah; header valid tanpa barang dilaporkan sebagai 0 barang. Script memakai `@next/env` untuk memuat konfigurasi seperti `next dev`, dan kondisi `react-server` agar modul server-only dapat dipakai dari Node.js. Jalankan tanpa `NODE_ENV=test`.

Jika muncul `CONFIG`, lengkapi `.env`. Untuk `ACCESS`, periksa API dan izin Viewer. Untuk `NOT_FOUND`, periksa ID serta akses spreadsheet. Untuk `SCHEMA`, periksa header atau sel yang disebutkan. Jangan mencetak objek error mentah dari Google karena dapat memuat metadata autentikasi.

Referensi: [Google Sheets values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get) dan [scope API](https://developers.google.com/workspace/sheets/api/scopes).

## Rule Parser dan Inventory Engine

Tiga tanggung jawab dipisahkan:

- `lib/parser/intents.ts` mendefinisikan 11 intent dan tipe `StructuredIntent`. Setiap hasil berisi `intent`, `product_query`, dan `quantity`.
- `lib/parser/rule-parser.ts` mengekspor fungsi murni `parseRuleIntent(text)`. Parser tidak membaca spreadsheet atau environment.
- `lib/inventory/inventory-engine.ts` mengekspor `executeInventoryIntent(intent)`. Engine server-side menjalankan intent baca melalui `readStok()`, yang menggunakan `lib/sheets/google-sheets.ts` untuk akses Google Sheets.

Contoh pemakaian dari kode server Node.js:

```ts
import { parseRuleIntent } from "@/lib/parser/rule-parser";
import { executeInventoryIntent } from "@/lib/inventory/inventory-engine";

const intent = parseRuleIntent("cek stok minyak goreng");
// { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null }
const result = await executeInventoryIntent(intent);
```

Parser menormalisasi huruf, spasi, tanda tanya/seru di akhir, serta beberapa variasi kata dan kata sopan. Frasa nama/SKU tanpa perintah menjadi `SEARCH_PRODUCT` sesuai keputusan awal. Percakapan umum, perintah yang tidak didukung, perintah belum lengkap, atau jumlah tidak valid menjadi `UNKNOWN`. Pembedaan nama dan percakapan menggunakan aturan heuristik, bukan pemahaman bahasa umum: nama yang belum dikenal tetap dapat dicari, sedangkan kata perintah yang dicadangkan dapat membuat nama tertentu tidak dikenali. Panjang input dibatasi 500 karakter.

Contoh lain: `minyak goreng tinggal berapa`, `lihat stok minyak`, `cari minyak`, `stok menipis`, `tambah stok minyak 20`, `kurangi stok minyak 5`, `set stok minyak 50`, `buat pesanan`, `batal`, `ya`, `tidak`, dan `bantuan`. Jumlah ditulis di akhir, mendukung desimal titik/koma tanpa pemisah ribuan. Tambah/kurangi mensyaratkan jumlah positif; set boleh 0. Mengenali intent perubahan stok tidak mengeksekusi perubahan apa pun.

Kontrak hasil engine:

| Intent/kondisi | `status` | Data |
| --- | --- | --- |
| `CHECK_STOCK`, satu kecocokan | `SUCCESS` | `product` |
| `CHECK_STOCK`, beberapa kecocokan | `MULTIPLE_MATCHES` | `products` dan `message` untuk meminta pilihan |
| `SEARCH_PRODUCT`, ditemukan | `SUCCESS` | Semua kandidat pada `products`, termasuk jika hanya satu |
| Cek/cari tanpa kecocokan | `NOT_FOUND` | `message` |
| Cek/cari dengan query kosong | `INVALID_QUERY` | `message`; tidak mengakses Sheets |
| `LOW_STOCK` | `SUCCESS` | `products`, dapat berupa array kosong |
| Intent selain tiga operasi baca | `UNSUPPORTED_INTENT` | `message`; tidak mengakses Sheets |

Setiap produk berisi `sku`, `name`, `unit`, `currentStock`, `minimumStock`, `status`, `rack`, dan `supplier`. Pencarian menggunakan substring nama atau SKU, case-insensitive, tanpa menghilangkan kandidat yang ambigu. `LOW_STOCK` memakai `currentStock <= minimumStock`; minimum kosong (`null`) dikecualikan. Nilai stok dan status berasal langsung dari spreadsheet, tanpa perhitungan ulang atau cache engine. Error service diteruskan sebagai error yang sudah disanitasi, bukan dianggap sebagai hasil kosong.

Unit test engine memakai reader pengganti tanpa jaringan. `test:inventory` memakai reader Google Sheets sebenarnya untuk cek stok, pencarian parsial, stok menipis, dan produk yang tidak ditemukan. Test tidak menulis data atau mencetak credentials maupun baris inventory. Perbandingan memakai snapshot awal; jalankan saat data spreadsheet tidak sedang diedit agar hasil konsisten.

## Starter Next.js

This project was bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
