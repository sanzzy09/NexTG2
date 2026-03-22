# NexBot — Bot Telegram Penjualan dengan Voucher & QRIS Otomatis

Bot Telegram untuk e-commerce sederhana dengan integrasi pembayaran QRIS via Pakasir, manajemen produk, voucher, backup, dan dashboard admin.

---

## Fitur Utama

- **Katalog Produk** — tampilkan, tambah,edit, hapus produk
- **Order & Pembayaran** — buat order, generate QRIS otomatis via Pakasir
- **Voucher & Diskon** — voucher percent/fixed, apply sebelum QRIS dibuat
- **Admin Panel** — inline keyboard, manage produk, voucher, backup, restore
- **Auto-status** — cek pembayaran otomatis setiap 30 detik
- **Auto-cancel** — batalkan order setelah 15 menit jika belum dibayar
- **Backup & Restore** — backup harian otomatis, restore manual, retensi 30 hari
- **Inline Keyboard** — navigasi dengan edit pesan (tidak spam)
- **Notifications** — toggle notifikasi pembayaran per user
- **Multi-admin** — simpan daftar admin di `admins.json`

---

## Struktur Folder

```
NEXBOT/
├── js/
│   ├── bot.js              # kode utama
│   ├── config.json         # konfigurasi (api key Pakasir, admin password)
│   ├── database/
│   │   ├── stats.json
│   │   ├── products.json
│   │   ├── orders.json
│   │   ├── users.json      # notifikasi settings
│   │   ├── vouchers.json   # data voucher
│   │   └── admins.json
│   ├── backups/            # zip backups
│   ├── qr_cache/           # gambar QRIS cache
│   └── node_modules/
├── README.md
└── .env.example            # contoh environment variables (opsional)
```

---

## Instalasi

1. **Clone repo** (setelah di-upload ke GitHub):
   ```bash
   git clone https://github.com/username/NexBot.git
   cd NexBot/js
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```
   Packages: `node-telegram-bot-api`, `qrcode`, `archiver`

3. **Konfigurasi**:
   - Edit `config.json`:
     ```json
     {
       "pakasir": {
         "apiKey": "<API_KEY_ANDA>",
         "slug": "nama-project-pakasir",
         "baseUrl": "https://app.pakasir.com/api"
       },
       "admin": {
         "password": "347100"
       }
     }
     ```
   - Ambil API key dari dashboard Pakasir.
   - `slug` adalah project slug di Pakasir.

4. **Jalankan bot**:
   ```bash
   node bot.js
   ```
   Bot akan mulai polling. Gunakan `pm2` atau `screen` untuk production.

---

## Cara Pakai

### User
- `/start` — menu utama
- `/products` — lihat katalog
- `/order <id>` — buat pesanan
- `/myorders` — lihat pesananmu
- `/status <order_id>` — cek status pembayaran
- `/voucher <kode>` — terapkan voucher ke order terakhir (sebelum QRIS)
- `/help` — bantuan

### Admin
- `/admin <password>` — login sebagai admin
- Setelah login, menu admin aktif:
  - `➕ Tambah Produk`
  - `🗑️ Hapus Produk`
  - `✏️ Edit Produk` (via command `/admin edit <id> <field> <value>`)
  - `📦 Lihat Produk`
  - `📋 Lihat Orders`
  - `💾 Backup Now`
  - `📜 List Backups` & `/restore <filename>`
  - `🎟️ Voucher` — tambah/list/hapus voucher
  - `/cancel <order_id>` — batalkan order
- `/admin logout` — keluar

### Voucher Commands (admin)
```bash
/voucher add <code> <percent|fixed> <value> [max_usage] [expire_days]
# contoh: /voucher add SAVE20 percent 20 50 30
/voucher list
/voucher del <code>
```

---

## API Integrasi (Pakasir)

Bot menggunakan endpoint:
- Create transaction: `POST /transactioncreate/qris`
- Detail transaction: `GET /transactiondetail`

Payload untuk create:
```json
{
  "project": "<slug>",
  "order_id": "<order_id>",
  "amount": <amount>,
  "api_key": "<api_key>"
```
Response berisi `payment.payment_number` untuk generate QR.

---

## Backup & Restore

- **Backup otomatis** setiap hari jam 00:00 (server time). Disimpan di `backups/` (zip).
- **Manual backup**: admin → `💾 Backup Now` atau `/backup`
- **List backups**: `/listbackups`
- **Restore**: `/restore <filename.zip>`
- Retensi: simpan 30 backup terakhir.

---

## Kustomisasi

- `products.json` — tambah produk manual via file atau admin panel.
- `vouchers.json` — tambah voucher manual (format JSON) atau via command.
- `config.json` — ubah admin password, Pakasir credentials.
- Interval auto-check: ubah `setInterval(autoCheckPayments, 30*1000)`.
- Auto-cancel timeout: ubah `15 * 60 * 1000` di `autoCancelExpiredOrders()`.

---

## Troubleshooting

**Bot tidak merespon:**
- Cek token bot di `config.json` (atau hardcoded di `bot.js`).
- Pastikan `node_modules` terinstall.
- Lihat log error di terminal.

**QRIS tidak muncul:**
- Cek API key & slug Pakasir valid.
- Pastikan endpoint `https://app.pakasir.com/api/transactioncreate/qris` reachable.
- Lihat response error di log (`Pakasir create error`).

**Voucher tidak bisa dipakai:**
- Voucher hanya bisa dipakai sebelum QRIS dibuat (belum ada `payment_number`).
- Cek status voucher: `/voucher list` (admin).
- Pastikan order masih `pending` atau `awaiting_payment`.

**Edit pesan tidak bekerja:**
- Some messages (photos) require `editMessageCaption`; fallback akan mengirim pesan baru.
- Jika menggunakan group/channel dengan admin restrictions, edit mungkin gagal.

---

## License

MIT

---

## Credits

Dibuat dengan ❤️ oleh NexBot.
 powered by OpenClaw & Node.js.
# NexTG
# NexTG
