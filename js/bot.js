const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const archiver = require('archiver');
const IndosmmAPI = require('./indosmm');

const token = '7441815149:AAFUoKkQm02Sd8BgFsqodNq0HENQpza8QOk';
const bot = new TelegramBot(token, { polling: true });

// Global error handlers to prevent crash
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.message ? err.message : err);
});

const DIR = __dirname;
const DB_DIR = path.join(DIR, 'database');
const STATS_FILE = path.join(DB_DIR, 'stats.json');
const PRODUCTS_FILE = path.join(DB_DIR, 'products.json');
const ORDERS_FILE = path.join(DB_DIR, 'orders.json');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const VOUCHERS_FILE = path.join(DB_DIR, 'vouchers.json');
const CONFIG_FILE = path.join(DIR, 'config.json');
const ADMINS_FILE = path.join(DB_DIR, 'admins.json');
const QR_CACHE_DIR = path.join(DIR, 'qr_cache');
const BACKUP_DIR = path.join(DIR, 'backups');

if (!fs.existsSync(QR_CACHE_DIR)) fs.mkdirSync(QR_CACHE_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// Config
let config = { pakasir: { apiKey: '', slug: '', baseUrl: 'https://app.pakasir.com/api' }, admin: { password: '' } };
if (fs.existsSync(CONFIG_FILE)) try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}

// Indosmm API
let indosmm = null;
if (config.indosmm && config.indosmm.apiKey) {
  indosmm = new IndosmmAPI(config.indosmm.apiKey);
}

// Admin
let admins = new Set();
if (fs.existsSync(ADMINS_FILE)) try { admins = new Set(JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'))); } catch (e) {}
function saveAdmins() { fs.writeFileSync(ADMINS_FILE, JSON.stringify([...admins])); }

// User settings
let users = {};
if (fs.existsSync(USERS_FILE)) try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) {}
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function getUserSetting(chatId, key, def) { return users[chatId]?.[key] ?? def; }
function setUserSetting(chatId, key, val) { if (!users[chatId]) users[chatId] = {}; users[chatId][key] = val; saveUsers(); }

// Vouchers
let vouchers = {};
if (fs.existsSync(VOUCHERS_FILE)) try { vouchers = JSON.parse(fs.readFileSync(VOUCHERS_FILE, 'utf8')); } catch (e) { vouchers = {}; }
function saveVouchers() { fs.writeFileSync(VOUCHERS_FILE, JSON.stringify(vouchers, null, 2)); }
function addVoucher(code, type, value, maxUsage = Infinity, expireDays = 30) {
  if (!vouchers[code]) vouchers[code] = {};
  vouchers[code].type = type;
  vouchers[code].value = value;
  vouchers[code].max_usage = maxUsage;
  vouchers[code].expire_days = expireDays;
  vouchers[code].created_at = new Date().toISOString();
  vouchers[code].used_count = vouchers[code].used_count || 0;
  saveVouchers();
}
function deleteVoucher(code) { delete vouchers[code]; saveVouchers(); }
function validateVoucher(code, orderTotal) {
  const v = vouchers[code];
  if (!v) return { ok: false, msg: 'Voucher tidak ditemukan.' };
  const created = new Date(v.created_at);
  const expiredDate = new Date(created.getTime() + v.expire_days * 24 * 60 * 60 * 1000);
  if (Date.now() > expiredDate) return { ok: false, msg: 'Voucher sudah kedaluwarsa.' };
  if (v.used_count >= v.max_usage) return { ok: false, msg: 'Voucher sudah mencapai batas penggunaan.' };
  let discount = 0;
  if (v.type === 'percent') {
    discount = Math.floor(orderTotal * (v.value / 100));
  } else {
    discount = Math.min(orderTotal, v.value);
  }
  return { ok: true, discount, v };
}
function applyVoucher(order, code) {
  // Jika QRIS sudah dibuat (payment_number ada), tolak apply
  if (order.payment_number) {
    return { ok: false, msg: 'Voucher hanya bisa diterapkan sebelum QRIS dibuat. Batalkan order atau hubungi admin.' };
  }
  const res = validateVoucher(code, order.total);
  if (!res.ok) return res;
  order.voucher_code = code;
  order.discount = res.discount;
  order.total_after_discount = order.total - res.discount;
  vouchers[code].used_count++;
  saveVouchers();
  saveOrders();
  return { ok: true, discount: res.discount, total_after: order.total_after_discount };
}

// Stats
let stats = { startTime: new Date(), totalMessages: 0, totalText: 0, totalPhoto: 0, totalSticker: 0 };
if (fs.existsSync(STATS_FILE)) try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch (e) {}
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }

// Products
let products = [];
if (fs.existsSync(PRODUCTS_FILE)) try { products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); } catch (e) { products = defaultProducts(); }
function defaultProducts() { return [{ id: 1, name: 'Paket Starter', price: 50000, desc: 'Untuk pemula' }, { id: 2, name: 'Paket Pro', price: 150000, desc: 'Untuk profesional' }, { id: 3, name: 'Paket Enterprise', price: 500000, desc: 'Untuk tim besar' }]; }
function saveProducts() { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2)); }

// Orders
let orders = [];
if (fs.existsSync(ORDERS_FILE)) try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch (e) { orders = []; }
function saveOrders() { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }

// Reload
function reloadData() {
  try {
    if (fs.existsSync(STATS_FILE)) stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) };
    if (fs.existsSync(PRODUCTS_FILE)) products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    if (fs.existsSync(ORDERS_FILE)) orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (fs.existsSync(VOUCHERS_FILE)) vouchers = JSON.parse(fs.readFileSync(VOUCHERS_FILE, 'utf8'));
    if (fs.existsSync(ADMINS_FILE)) admins = new Set(JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')));
  } catch (e) { console.error('Reload error:', e.message); }
}

// Category helpers
function getProductsByCategory(category) {
  if (!category) return products;
  return products.filter(p => (p.category || 'Lainnya') === category);
}
function getCategories() {
  const cats = new Set(products.map(p => p.category || 'Lainnya'));
  return Array.from(cats).sort();
}

// Balance helpers
function getBalance(chatId) {
  const u = users[chatId] || {};
  return Math.max(0, u.balance || 0);
}
function setBalance(chatId, amount) {
  if (!users[chatId]) users[chatId] = {};
  users[chatId].balance = Math.max(0, amount);
  saveUsers();
}
function addBalance(chatId, amount) {
  const current = getBalance(chatId);
  setBalance(chatId, current + amount);
}
function deductBalance(chatId, amount) {
  const current = getBalance(chatId);
  if (current < amount) return false;
  setBalance(chatId, current - amount);
  return true;
}

function formatUser(userId) {
  const u = users[userId];
  if (u && u.username) return `@${u.username}`;
  return String(userId);
}

// Voucher pending state (input via inline)
let voucherPending = {}; // chatId -> orderId
// Indosmm link pending (chatId -> orderId)
let linkPending = {};
// Indosmm quantity pending (chatId -> orderId)
let quantityPending = {};

// Backup
function createBackupFilename() {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0'), ss = String(now.getSeconds()).padStart(2, '0');
  return path.join(BACKUP_DIR, `backup_${y}${m}${d}_${hh}${mm}${ss}.zip`);
}
async function createBackup() {
  return new Promise((resolve, reject) => {
    const zipPath = createBackupFilename();
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(DB_DIR)) archive.directory(DB_DIR, false);
    if (fs.existsSync(CONFIG_FILE)) archive.file(CONFIG_FILE, { name: 'config.json' });
    archive.finalize();
  });
}
function listBackups() { if (!fs.existsSync(BACKUP_DIR)) return []; return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip')).sort().reverse(); }
async function restoreBackup(filename) {
  const zipPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(zipPath)) throw new Error('File backup tidak ditemukan');
  return new Promise((resolve, reject) => {
    const archive = archiver('zip');
    archive.on('error', reject);
    archive.on('warning', err => { if (err.code === 'ENOENT') reject(new Error('File backup tidak valid')); else console.warn(err); });
    archive.on('end', () => { reloadData(); resolve(); });
    const input = fs.createReadStream(zipPath);
    input.on('error', reject);
    input.pipe(archive);
    archive.extract(DB_DIR);
    archive.finalize();
  });
}
function scheduleDailyBackup() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const msUntilMidnight = midnight - now;
  setTimeout(() => { runDailyBackup(); setInterval(runDailyBackup, 24 * 60 * 60 * 1000); }, msUntilMidnight);
}
async function runDailyBackup() {
  try {
    const zipPath = await createBackup();
    console.log(`Daily backup: ${zipPath}`);
    await notifyAdmins(`✅ Daily backup selesai: ${path.basename(zipPath)}`);
    const backups = listBackups();
    if (backups.length > 30) for (const f of backups.slice(30)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { console.error('Daily backup error:', e); }
}
scheduleDailyBackup();

// Notifikasi
async function notifyAdmins(message) {
  const formattedMessage = message.replace(/User: (\d+)/g, (match, userId) => {
    return `User: ${formatUser(Number(userId))}`;
  });
  for (const adminId of admins) try { await bot.sendMessage(adminId, formattedMessage); } catch (e) {}
}

// Pakasir
async function createPakasirTransaction(order) {
  try {
    const payload = { project: config.pakasir.slug, order_id: order.id.toString(), amount: order.total, api_key: config.pakasir.apiKey };
    const resp = await fetch(`${config.pakasir.baseUrl}/transactioncreate/qris`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) { console.error('Pakasir create error:', e); return null; }
}
async function getPakasirTransaction(orderId, amount) {
  try {
    const url = new URL(`${config.pakasir.baseUrl}/transactiondetail`);
    url.searchParams.append('project', config.pakasir.slug);
    url.searchParams.append('order_id', orderId.toString());
    url.searchParams.append('amount', amount.toString());
    url.searchParams.append('api_key', config.pakasir.apiKey);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) { console.error('Pakasir detail error:', e); return null; }
}
async function generateQRImage(paymentNumber) {
  const filePath = path.join(QR_CACHE_DIR, `qr_${paymentNumber}.png`);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  // Reduce size to avoid Telegram 413 error
  await QRCode.toFile(filePath, paymentNumber, { width: 300, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
  return fs.readFileSync(filePath);
}

// Indosmm
async function createIndosmmOrder(order, link) {
  if (!indosmm) {
    console.error('Indosmm API tidak diinisialisasi. Cek config.json');
    return null;
  }
  try {
    const product = products.find(p => p.id === order.product_id);
    if (!product) {
      console.error(`Produk ID ${order.product_id} tidak ditemukan`);
      return null;
    }
    if (!product.service) {
      console.error(`Produk "${product.name}" (ID ${product.id}) tidak memiliki service ID. Jalankan /sync_indosmm.`);
      return null;
    }
    console.log(`Indosmm order: service=${product.service}, link=${link}, qty=${order.quantity}`);
    const res = await indosmm.addOrder(product.service, link, order.quantity);
    if (res && res.order) {
      console.log(`Indosmm order created: order_id=${res.order}`);
      return res.order;
    }
    console.error('Indosmm response tidak valid:', res);
    return null;
  } catch (e) {
    console.error('Indosmm create error:', e.message || e);
    return null;
  }
}
async function getIndosmmStatus(orderId) {
  if (!indosmm) return null;
  try {
    const res = await indosmm.getStatus(orderId);
    return res;
  } catch (e) { console.error('Indosmm status error:', e); return null; }
}

// Auto
async function autoCheckPayments() {
  const pendingOrders = orders.filter(o => o.pakasir_transaction_id && ['awaiting_payment', 'pending'].includes(o.status));
  if (!pendingOrders.length) return;
  for (const order of pendingOrders) {
    try {
      const amountToCheck = order.total_after_discount || order.total;
      const res = await getPakasirTransaction(order.id, amountToCheck);
      if (res && res.transaction && res.transaction.status && res.transaction.status !== order.status) {
        const oldStatus = order.status;
        order.status = res.transaction.status;
        saveOrders();
        const notify = getUserSetting(order.user_id, 'notifications', true);
        if (notify) try { await bot.sendMessage(order.user_id, `📢 Order #${order.id}: "${oldStatus}" → "${order.status}"`); } catch (e) {}
        await notifyAdmins(`📢 Order #${order.id} status: ${oldStatus} → ${order.status}\nUser: ${order.user_id}\nProduk: ${order.product_name}\nTotal: Rp ${order.total.toLocaleString('id-ID')}`);
        // Topup: credit balance when payment success (only once)
        if (order.is_topup && (order.status === 'success' || order.status === 'paid') && !order.topup_processed) {
          addBalance(order.user_id, order.total);
          order.topup_processed = true;
          saveOrders();
          await notifyAdmins(`✅ Top Up #${order.id} sukses. Saldo pengguna +Rp ${order.total.toLocaleString('id-ID')}`);
          try {
            const newBal = getBalance(order.user_id);
            await bot.sendMessage(order.user_id, `✅ Top Up saldo Rp ${order.total.toLocaleString('id-ID')} berhasil.\nSaldo Anda sekarang: Rp ${newBal.toLocaleString('id-ID')}`);
          } catch (e) {}
        }
      }
    } catch (e) { console.error('Auto-check error:', e); }
  }
}
setInterval(autoCheckPayments, 30 * 1000);

async function autoCancelExpiredOrders() {
  const now = Date.now();
  const expiredOrders = orders.filter(o => ['awaiting_payment', 'pending'].includes(o.status) && (now - new Date(o.timestamp).getTime()) > 15 * 60 * 1000);
  for (const order of expiredOrders) {
    order.status = 'cancelled';
    // Refund balance for Pakasir orders (non-Indosmm, non-topup) if deducted
    if (!order.indosmm_order_id && !order.is_topup) {
      addBalance(order.user_id, order.total);
      try { await bot.sendMessage(order.user_id, `⏰ Order #${order.id} expired. Saldo Rp ${order.total.toLocaleString('id-ID')} telah dikembalikan.`); } catch (e) {}
      await notifyAdmins(`⏰ Order #${order.id} auto-cancelled + refund.\nUser: ${order.user_id}\nRefund: Rp ${order.total}`);
    } else {
      try { await bot.sendMessage(order.user_id, `⏰ Order #${order.id} expired (dibatalkan otomatis).`); } catch (e) {}
      await notifyAdmins(`⏰ Order #${order.id} auto-cancelled${order.is_topup ? ' (topup)' : ''}.\nUser: ${order.user_id}`);
    }
    saveOrders();
  }
}
setInterval(autoCancelExpiredOrders, 60 * 1000);

// Auto-check Indosmm orders
async function autoCheckIndosmmOrders() {
  const indosmmOrders = orders.filter(o => o.indosmm_order_id && ['pending','processing','completed','failed','cancelled'].includes(o.status));
  if (!indosmmOrders.length) return;
  for (const order of indosmmOrders) {
    try {
      const res = await getIndosmmStatus(order.indosmm_order_id);
      if (res && res.status && res.status !== order.status) {
        const oldStatus = order.status;
        order.status = res.status;
        // Update remains/charge if available
        if (res.remains !== undefined) order.remains = res.remains;
        if (res.charge !== undefined) order.charge = res.charge;
        saveOrders();
        const notify = getUserSetting(order.user_id, 'notifications', true);
        if (notify) try { await bot.sendMessage(order.user_id, `📢 Order #${order.id} (Indosmm) status: ${oldStatus} → ${order.status}`); } catch (e) {}
        await notifyAdmins(`📢 Order #${order.id} (Indosmm) status: ${oldStatus} → ${order.status}\nUser: ${order.user_id}\nProduk: ${order.product_name}`);
      }
    } catch (e) { console.error('Auto-check Indosmm error:', e); }
  }
}
setInterval(autoCheckIndosmmOrders, 30 * 1000);

// IDs
function nextOrderId() { return orders.reduce((m, o) => Math.max(m, o.id || 0), 0) + 1; }
function nextProductId() { return products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1; }

// Helper: edit dengan fallback, mendukung photo caption
async function editOrSend(chatId, messageId, text, opts = {}, isPhoto = false) {
  try {
    if (isPhoto) {
      await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, ...opts });
    } else {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    }
  } catch (e) {
    await bot.sendMessage(chatId, text, opts);
  }
}

// Keyboards
function mainKb(isAdmin) {
  const rows = [
    [{ text: '🛍️ Products', callback_data: 'products' }, { text: '📦 My Orders', callback_data: 'myorders' }],
    [{ text: '💰 Saldo', callback_data: 'saldo' }, { text: '🔋 Top Up', callback_data: 'topup_help' }],
    [{ text: 'ℹ️ Help', callback_data: 'help' }, { text: '🔔 Notifications', callback_data: 'notif_settings' }]
  ];
  if (isAdmin) rows.push([{ text: '🔐 Admin Panel', callback_data: 'admin_panel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}
function productsKb(category, page = 1) {
  const list = getProductsByCategory(category);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const items = list.slice(start, end);

  const rows = items.map(p => [{ text: `${p.id}. ${p.name} - Rp ${p.price.toLocaleString('id-ID')}`, callback_data: `order_${p.id}` }]);

  // Pagination controls: format products_page_<page>_<category_enc>
  const nav = [];
  const catEnc = encodeURIComponent(category || '');
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `products_page_${page - 1}_${catEnc}` });
  if (end < list.length) nav.push({ text: 'Next ➡️', callback_data: `products_page_${page + 1}_${catEnc}` });
  if (nav.length) rows.push(nav);

  if (category) {
    rows.push([{ text: '🔙 Kembali ke Kategori', callback_data: 'categories' }]);
  } else {
    rows.push([{ text: '🔙 Kembali', callback_data: 'start' }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}
function categoriesKb() {
  const cats = getCategories();
  const rows = [
    [{ text: '🛍️ Semua Produk', callback_data: 'products_all' }],
    ...cats.map(c => [{ text: c, callback_data: `category_${c}` }]),
    [{ text: '🔙 Kembali', callback_data: 'start' }]
  ];
  return { reply_markup: { inline_keyboard: rows } };
}
function orderDetailKb(order) {
  const rows = [];
  // Show "Sudah Bayar" only for Pakasir orders (non-topup, non-Indosmm) that are awaiting payment
  if (!order.indosmm_order_id && !order.is_topup && order.status === 'awaiting_payment') {
    rows.push([{ text: '✅ Sudah Bayar', callback_data: `paid_${order.id}` }]);
  }
  rows.push([{ text: '🔁 Cek Status', callback_data: `status_${order.id}` }]);
  rows.push([{ text: '🗑️ Batalkan', callback_data: `cancel_${order.id}` }]);
  rows.push([{ text: '🔙 Kembali', callback_data: 'myorders' }]);
  return { reply_markup: { inline_keyboard: rows } };
}
function adminKb() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Tambah', callback_data: 'admin_add_help' }, { text: '🗑️ Hapus', callback_data: 'admin_del_help' }],
        [{ text: '✏️ Edit', callback_data: 'admin_edit_help' }, { text: '📦 Lihat Produk', callback_data: 'admin_products' }],
        [{ text: '🌐 Sync Indosmm', callback_data: 'admin_sync_indosmm' }],
        [{ text: '📋 Lihat Orders', callback_data: 'admin_orders' }],
        [{ text: '💾 Backup Now', callback_data: 'admin_backup' }, { text: '📜 List Backups', callback_data: 'admin_listbackups' }],
        [{ text: '🔙 Kembali', callback_data: 'start' }]
      ]
    }
  };
}
function notifKb(chatId) {
  const on = getUserSetting(chatId, 'notifications', true);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔔 Notifikasi: ${on ? 'ON' : 'OFF'}`, callback_data: 'notif_toggle' }],
        [{ text: '🔙 Kembali', callback_data: 'start' }]
      ]
    }
  };
}

// Callback
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (query.from && query.from.username) {
    if (!users[chatId]) users[chatId] = {};
    users[chatId].username = query.from.username;
    saveUsers();
  }
  const msgId = query.message.message_id;
  const data = query.data;
  const isPhoto = !!query.message.photo;
  try { await bot.answerCallbackQuery(query.id); } catch (e) { /* ignore */ }

  const edit = (text, kb) => editOrSend(chatId, msgId, text, kb, isPhoto);

  if (data === 'start') {
    const isAdmin = admins.has(chatId);
    const bal = getBalance(chatId);
    let text = '🤖 *NexTG Bot*\n';
    text += `• Runtime: Node ${process.version}\n`;
    text += `• Admin: ${Array.from(admins).join(', ') || 'Tidak ada'}\n\n`;
    text += `👤 *User Anda:*\n`;
    text += `• Username: @${query.from?.username || 'N/A'}\n`;
    text += `• User ID: ${chatId}\n`;
    text += `• Saldo: Rp ${bal.toLocaleString('id-ID')}\n\n`;
    text += `Selamat datang! Pilih menu:`;
    return edit(text, { parse_mode: 'Markdown', ...mainKb(isAdmin) });
  }

  if (data === 'saldo') {
    const bal = getBalance(chatId);
    return edit(`💰 Saldo Anda: Rp ${bal.toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
  }

  if (data === 'topup_help') {
    const text = `🔋 Top Up Saldo\n\nGunakan perintah:\n/topup <jumlah>\n\nContoh: /topup 20000\n\nMinimal topup Rp 5.000\n\nSetelah mengirim perintah, akan muncul QRIS untuk dibayar. Setelah pembayaran sukses, saldo akan bertambah otomatis.`;
    return edit(text, mainKb(admins.has(chatId)));
  }

  if (data === 'products') {
    if (!products.length) return edit('Katalog kosong.', mainKb(admins.has(chatId)));
    return edit('Pilih kategori produk:', categoriesKb());
  }

  if (data === 'products_all') {
    if (!products.length) return edit('Katalog kosong.', mainKb(admins.has(chatId)));
    return edit('Pilih produk (halaman 1):', productsKb(null, 1));
  }

  if (data === 'categories') {
    if (!products.length) return edit('Katalog kosong.', mainKb(admins.has(chatId)));
    return edit('Pilih kategori produk:', categoriesKb());
  }

  if (data.startsWith('category_')) {
    const cat = decodeURIComponent(data.slice(9));
    const list = getProductsByCategory(cat);
    if (!list.length) return edit(`Tidak ada produk di kategori ${cat}.`, categoriesKb());
    return edit(`📦 Kategori: ${cat} (halaman 1)`, productsKb(cat, 1));
  }

  if (data.startsWith('products_page_')) {
    // format: products_page_<page>_<category_encoded>
    const parts = data.split('_');
    if (parts.length < 3) return edit('Param tidak valid.', mainKb(admins.has(chatId)));
    const page = parseInt(parts[2], 10);
    const category = parts.length > 3 ? decodeURIComponent(parts.slice(3).join('_')) : null;
    const list = getProductsByCategory(category);
    if (!list.length) return edit('Katalog kosong.', category ? categoriesKb() : mainKb(admins.has(chatId)));
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    if (page < 1 || page > totalPages) {
      return edit(`Halaman tidak valid.`, productsKb(category, 1));
    }
    const items = list.slice((page - 1) * pageSize, page * pageSize);
    let text = category ? `📦 Kategori: ${category} (halaman ${page}/${totalPages})\n` : `📦 Semua Produk (halaman ${page}/${totalPages})\n`;
    items.forEach(p => { text += `${p.id}. ${p.name} - Rp ${p.price.toLocaleString('id-ID')}\n   ${p.desc || ''}\n`; });
    return edit(text, productsKb(category, page));
  }

  if (data === 'myorders') {
    stats.totalMessages++; saveStats();
    const myOrders = orders.filter(o => o.user_id === chatId);
    if (!myOrders.length) return edit('Belum ada pesanan.', mainKb(admins.has(chatId)));
    let list = '📋 Pesanan Anda:\n';
    myOrders.forEach(o => {
      const displayTotal = o.total_after_discount || o.total;
      list += `#${o.id} ${o.product_name} - Rp ${displayTotal.toLocaleString('id-ID')} [${o.status}] Qty: ${o.quantity}\n`;
    });
    return edit(list + '\nPilih order untuk detail:', {
      reply_markup: {
        inline_keyboard: myOrders.map(o => [{ text: `Order #${o.id} (${o.status})`, callback_data: `orderdetail_${o.id}` }]).concat([{ text: '🔙 Kembali', callback_data: 'start' }])
      }
    });
  }

  if (data.startsWith('orderdetail_')) {
    const orderId = parseInt(data.split('_')[1], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    let text = `📦 Order #${order.id}\nProduk: ${order.product_name}\nQty: ${order.quantity}\nHarga: Rp ${order.price.toLocaleString('id-ID')}\n`;
    if (order.voucher_code) {
      text += `🎟️ Voucher: ${order.voucher_code} (Rp ${order.discount.toLocaleString('id-ID')})\n`;
    }
    text += `Total: Rp ${(order.total_after_discount || order.total).toLocaleString('id-ID')}\nStatus: ${order.status}\nTanggal: ${new Date(order.timestamp).toLocaleString('id-ID')}`;
    if (order.pakasir_transaction_id) text += `\nTxID: ${order.pakasir_transaction_id}`;
    if (order.indosmm_order_id) text += `\nIndosmm Order ID: ${order.indosmm_order_id}`;
    return edit(text, orderDetailKb(order));
  }

  if (data.startsWith('qty_')) {
    const parts = data.split('_');
    const orderId = parseInt(parts[1], 10), action = parts[2];
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    if (!['pending', 'awaiting_payment'].includes(order.status)) return edit('Order tidak bisa diubah quantity.', orderDetailKb(order));
    if (action === 'plus') order.quantity += 1;
    if (action === 'minus' && order.quantity > 1) order.quantity -= 1;
    order.total = order.price * order.quantity;
    if (order.voucher_code) {
      const v = vouchers[order.voucher_code];
      if (v) {
        if (v.type === 'percent') {
          order.discount = Math.floor(order.total * (v.value / 100));
        } else {
          order.discount = Math.min(order.total, v.value);
        }
        order.total_after_discount = order.total - order.discount;
      }
    }
    saveOrders();
    const displayTotal = order.total_after_discount || order.total;
    let text = `✅ Qty: ${order.quantity}\nTotal: Rp ${displayTotal.toLocaleString('id-ID')}`;
    return edit(text, orderDetailKb(order));
  }

  if (data.startsWith('order_') && !data.startsWith('orderdetail_')) {
    const prodId = parseInt(data.split('_')[1], 10);
    const product = products.find(p => p.id === prodId);
    if (!product) return edit('Produk tidak ditemukan.', mainKb(admins.has(chatId)));
    return edit(`Yakin pesan ${product.name} seharga Rp ${product.price.toLocaleString('id-ID')}?`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Ya, Buat', callback_data: `confirmorder_${prodId}` }], [{ text: '🔙 Kembali', callback_data: 'products' }]] }
    });
  }

  if (data.startsWith('confirmorder_')) {
    const prodId = parseInt(data.split('_')[1], 10);
    const product = products.find(p => p.id === prodId);
    if (!product) return edit('Produk tidak ditemukan.', mainKb(admins.has(chatId)));
    const orderId = nextOrderId();
    // Initialize order with quantity=0, total=0; fill later for SMM; for others set now
    const order = {
      id: orderId,
      user_id: chatId,
      product_id: product.id,
      product_name: product.name,
      price: product.price,
      quantity: 0,
      total: 0,
      timestamp: new Date().toISOString(),
      status: 'pending',
      pakasir_transaction_id: null,
      payment_number: null,
      voucher_code: null,
      discount: 0,
      total_after_discount: null,
      indosmm_order_id: null
    };
    orders.push(order); saveOrders();
    stats.totalMessages++; saveStats();

    const category = product.category || 'Lainnya';
    if (category === 'Suntik SMM') {
      // Step 1: minta link
      linkPending[chatId] = orderId;
      return edit(`Order #${orderId} untuk ${product.name}.\nKirim link/username/target yang ingin di-${product.name} (contoh: @username atau https://...).`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'products' }]] }
      });
    } else {
      // Non-SMM: quantity default 1, calculate total with fee
      const total = Math.ceil(product.price * 1.2);
      order.quantity = 1;
      order.total = total;
      // Check balance first
      if (!deductBalance(chatId, total)) {
        order.status = 'cancelled';
        saveOrders();
        return edit(`❌ Saldo tidak cukup. Di butuh Rp ${total.toLocaleString('id-ID')}. Saldo Anda: Rp ${getBalance(chatId).toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
      }
      await edit(`⏳ Membuat pembayaran QRIS untuk Order #${orderId}...`, mainKb(admins.has(chatId)));
      const orderForTx = { ...order, total: total };
      const pkgRes = await createPakasirTransaction(orderForTx);
      if (pkgRes && pkgRes.payment && pkgRes.payment.payment_number) {
        order.pakasir_transaction_id = orderId.toString();
        order.payment_number = pkgRes.payment.payment_number;
        order.status = 'awaiting_payment'; saveOrders();
        try {
          const qrBuffer = await generateQRImage(order.payment_number);
          await bot.sendPhoto(chatId, qrBuffer, { caption: `✅ Order #${orderId}\nProduk: ${product.name}\nQty: ${order.quantity}\nTotal: Rp ${total.toLocaleString('id-ID')}\nSilakan scan QRIS.`, reply_markup: orderDetailKb(order) });
        } catch (e) {
          await bot.sendMessage(chatId, `QRIS: ${order.payment_number}`, { reply_markup: orderDetailKb(order) });
        }
        await notifyAdmins(`📢 Order baru #${orderId}\nUser: ${chatId}\nProduk: ${product.name}\nTotal: Rp ${total.toLocaleString('id-ID')}\nStatus: ${order.status}`);
      } else {
        order.status = 'cancelled';
        addBalance(chatId, total); // refund
        saveOrders();
        await bot.sendMessage(chatId, `⚠️ Gagal buat QRIS. Saldo Rp ${total} telah dikembalikan. Pesanan #${orderId} dibatalkan.`);
        await notifyAdmins(`⚠️ Order #${orderId} gagal dibuat QRIS (saldo dikembalikan).\nUser: ${chatId}\nProduk: ${product.name}`);
      }
      return;
    }
  }

  if (data.startsWith('voucher_input_')) {
    const orderId = parseInt(data.split('_')[2], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    voucherPending[chatId] = orderId;
    return edit('Masukkan kode voucher (contoh: DISKON20) di chat, lalu kirim.\n\nKamu bisa mengetik langsung.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: `orderdetail_${orderId}` }]] }
    });
  }

  if (data.startsWith('voucher_help_')) {
    const orderId = parseInt(data.split('_')[2], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    return edit('Gunakan tombol "Apply Voucher" untuk masukkan kode.\nAtau kirim perintah: /voucher <kode>', orderDetailKb(order));
  }

  if (data.startsWith('paid_')) {
    const orderId = parseInt(data.split('_')[1], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    if (order.indosmm_order_id) return edit('Order Indosmm tidak bisa di-set paid manual.', orderDetailKb(order));
    if (order.status !== 'awaiting_payment') return edit(`Order sudah dalam status "${order.status}".`, orderDetailKb(order));
    // Manual payment confirmation: deduct balance now? Actually for Pakasir, balance already deducted at order time. Just mark paid.
    order.status = 'paid';
    saveOrders();
    await edit(`✅ Order #${orderId} ditandai sudah bayar.`, orderDetailKb(order));
    await notifyAdmins(`📢 Order #${orderId} ditandai paid oleh user.\nUser: ${order.user_id}\nProduk: ${order.product_name}`);
    return;
  }

  if (data.startsWith('cancel_')) {
    const orderId = parseInt(data.split('_')[1], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    if (order.status === 'paid') return edit('Order sudah dibayar, tidak bisa dibatalkan.', orderDetailKb(order));
    order.status = 'cancelled';
    saveOrders();
    // Refund for Pakasir orders (if balance was deducted)
    if (!order.indosmm_order_id && !order.is_topup) {
      addBalance(chatId, order.total);
      await bot.sendMessage(chatId, `💸 Saldo Rp ${order.total.toLocaleString('id-ID')} telah dikembalikan.`, mainKb(admins.has(chatId)));
      await notifyAdmins(`⚠️ Order #${orderId} dibatalkan, saldo dikembalikan: Rp ${order.total}`);
    } else {
      await edit(`✅ Order #${orderId} dibatalkan.`, mainKb(admins.has(chatId)));
    }
    try { await bot.sendMessage(order.user_id, `📢 Order #${orderId} Anda dibatalkan.`); } catch (e) {}
    if (!order.indosmm_order_id) await notifyAdmins(`📢 Order #${orderId} dibatalkan oleh user (refunded).\nUser: ${order.user_id}`);
    return;
  }

  if (data.startsWith('status_')) {
    const orderId = parseInt(data.split('_')[1], 10);
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (!order) return edit('Order tidak ditemukan.', mainKb(admins.has(chatId)));
    await edit(`🔎 Mengecek status Order #${orderId}...`, orderDetailKb(order));
    if (order.indosmm_order_id) {
      const res = await getIndosmmStatus(order.indosmm_order_id);
      if (res && res.status) {
        order.status = res.status;
        if (res.remains !== undefined) order.remains = res.remains;
        if (res.charge !== undefined) order.charge = res.charge;
        saveOrders();
        edit(`Status (Indosmm): ${order.status}\nOrder #${orderId} adalah "${order.status}"`, orderDetailKb(order));
      } else {
        edit('Gagal mengambil status dari Indosmm.', orderDetailKb(order));
      }
    } else if (order.pakasir_transaction_id) {
      const amountToCheck = order.total_after_discount || order.total;
      const res = await getPakasirTransaction(order.id, amountToCheck);
      if (res && res.transaction && res.transaction.status) {
        order.status = res.transaction.status;
        saveOrders();
        edit(`Status (Pakasir): ${order.status}\nOrder #${orderId} adalah "${order.status}"`, orderDetailKb(order));
      } else {
        edit('Gagal mengambil status dari Pakasir.', orderDetailKb(order));
      }
    } else {
      edit(`Order #${orderId} belum terintegrasi. Status: ${order.status}`, orderDetailKb(order));
    }
    return;
  }

  if (data === 'notif_settings') {
    const on = getUserSetting(chatId, 'notifications', true);
    return edit(`🔔 Notifikasi pembayaran: ${on ? 'ON' : 'OFF'}\n\nKlik tombol below untuk toggle.`, notifKb(chatId));
  }
  if (data === 'notif_toggle') {
    const on = getUserSetting(chatId, 'notifications', true);
    setUserSetting(chatId, 'notifications', !on);
    return edit(`✅ Notifikasi di-${!on ? 'AKTIF' : 'NON-AKTIF'}kan.`, notifKb(chatId));
  }

  if (data === 'help') {
    const isAdmin = admins.has(chatId);
    let text = 'Perintah:\n/start - Sapaan\n/help - Bantuan\n/stats - Statistik\n/products - Katalog\n/order <id> - Pesan\n/myorders - Pesananmu\n/status <order_id> - Cek pembayaran\n/voucher <kode> - Pakai voucher\n\n';
    if (isAdmin) text += 'Admin:\n/admin logout\n/admin add <nama> <harga> <deskripsi>\n/admin del <id>\n/admin products\n/admin orders\n/cancel <order_id>\n/voucher add <code> <percent|fixed> <value> [max_usage] [expire_days]\n/voucher list\n/voucher del <code>\n/backup\n/listbackups\n/restore <filename>';
    else text += 'Admin: /admin <password>';
    return edit(text, mainKb(isAdmin));
  }

  if (data === 'admin_panel') {
    if (!admins.has(chatId)) return edit('Akses ditolak. Login dulu dengan /admin <password>.', mainKb(false));
    return edit('🔐 Admin Panel:\nPilih aksi:', adminKb());
  }
  if (data === 'admin_add_help') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    return edit('Gunakan:\n/admin add <nama> <harga> <deskripsi>\nContoh: /admin add Paket Basic 50000 Untuk pemula', adminKb());
  }
  if (data === 'admin_del_help') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    return edit('Gunakan:\n/admin del <id>\nContoh: /admin del 1', adminKb());
  }
  if (data === 'admin_edit_help') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    return edit('Gunakan:\n/admin edit <id> <field> <value>\nfield: name, price, desc\nContoh: /admin edit 1 name "Nama Baru"', adminKb());
  }
  if (data === 'admin_products') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    if (!products.length) return edit('Katalog kosong.', adminKb());
    let list = '📦 Katalog Produk:\n';
    products.forEach(p => { list += `${p.id}. ${p.name} - Rp ${p.price.toLocaleString('id-ID')}\n   ${p.desc || ''}\n`; });
    edit(list, adminKb());
    const rows = products.map(p => [{ text: `✏️ Edit ${p.id}`, callback_data: `edit_product_${p.id}` }]);
    rows.push([{ text: '🔙 Kembali', callback_data: 'admin_panel' }]);
    return edit('Pilih produk untuk diedit:', { reply_markup: { inline_keyboard: rows } });
  }
  if (data.startsWith('edit_product_')) {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    const productId = parseInt(data.split('_')[2], 10);
    const product = products.find(p => p.id === productId);
    if (!product) return edit('Produk tidak ditemukan.', adminKb());
    return edit(`Edit produk: ${product.name}\n\nGunakan:\n/admin edit ${productId} name "Nama Baru"\n/admin edit ${productId} price 12345\n/admin edit ${productId} desc "Deskripsi Baru"`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'admin_products' }]] }
    });
  }
  if (data === 'admin_orders') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    if (!orders.length) return edit('Belum ada pesanan.', adminKb());
    let list = '📋 Semua Pesanan:\n';
    orders.forEach(o => { list += `#${o.id} @${o.user_id} ${o.product_name} - Rp ${o.total.toLocaleString('id-ID')} [${o.status}] Qty: ${o.quantity}\n`; });
    return edit(list, adminKb());
  }
  if (data === 'admin_sync_indosmm') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    if (!indosmm) return edit('Indosmm API tidak dikonfigurasi (config.json).', adminKb());
    edit('⏳ Menyinkronkan layanan dari indosmm.id...');
    try {
      const services = await indosmm.getServices();
      if (!Array.isArray(services)) throw new Error('Respons tidak valid');
      let added = 0, updated = 0;
      for (const s of services) {
        const category = 'Suntik SMM';
        const existing = products.find(p => p.service === s.service);
        if (existing) {
          existing.name = s.name;
          existing.price = parseFloat(s.rate);
          existing.desc = `Category: ${s.category}\nMin: ${s.min}\nMax: ${s.max}\nRefill: ${s.refill ? 'Yes' : 'No'}\nCancel: ${s.cancel ? 'Yes' : 'No'}`;
          existing.category = category;
          updated++;
        } else {
          const newId = nextProductId();
          products.push({
            id: newId,
            name: s.name,
            price: parseFloat(s.rate),
            desc: `Category: ${s.category}\nMin: ${s.min}\nMax: ${s.max}\nRefill: ${s.refill ? 'Yes' : 'No'}\nCancel: ${s.cancel ? 'Yes' : 'No'}`,
            category: category,
            service: s.service
          });
          added++;
        }
      }
      saveProducts();
      edit(`✅ Sinkronisasi selesai.\n+${added} layanan baru\n~${updated} diperbarui\nTotal: ${products.length}`, adminKb());
    } catch (e) {
      edit(`❌ Gagal sinkron: ${e.message}`, adminKb());
    }
    return;
  }
  if (data === 'admin_backup') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    edit('⏳ Membuat backup...');
    try {
      const zipPath = await createBackup();
      const filename = path.basename(zipPath);
      edit(`✅ Backup selesai: ${filename}\nUkuran: ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`, adminKb());
    } catch (e) {
      edit(`❌ Gagal backup: ${e.message}`, adminKb());
    }
    return;
  }
  if (data === 'admin_listbackups') {
    if (!admins.has(chatId)) return edit('Akses ditolak.', adminKb());
    const files = listBackups();
    if (!files.length) return edit('Belum ada backup.', adminKb());
    let list = '📁 Backup Files:\n';
    files.forEach((f, i) => { const stat = fs.statSync(path.join(BACKUP_DIR, f)); list += `${i+1}. ${f} (${(stat.size/1024).toFixed(1)} KB)\n`; });
    return edit(list + '\nGunakan /restore <filename> untuk restore.', adminKb());
  }

  edit('Perintah tidak dikenal.', mainKb(admins.has(chatId)));
});

// Text commands
bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const isAdmin = admins.has(chatId);
  const user = users[chatId] || {};
  const bal = getBalance(chatId);
  let text = '🤖 *NexTG Bot*\n';
  text += `• Runtime: Node ${process.version}\n`;
  text += `• Admin: ${Array.from(admins).join(', ') || 'Tidak ada'}\n\n`;
  text += `👤 *User Anda:*\n`;
  text += `• Username: @${msg.from.username || 'N/A'}\n`;
  text += `• User ID: ${chatId}\n`;
  text += `• Saldo: Rp ${bal.toLocaleString('id-ID')}\n\n`;
  text += `Selamat datang! Pilih menu:`;
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...mainKb(isAdmin) });
});

bot.onText(/^\/help$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const isAdmin = admins.has(chatId);
  let text = 'Perintah:\n/start - Sapaan\n/help - Bantuan\n/stats - Statistik\n/products - Katalog\n/myorders - Pesananmu\n/status <order_id> - Cek status\n/saldo - Cek saldo\n/topup <jumlah> - Isi saldo via QRIS\n\n';
  if (isAdmin) text += 'Admin:\n/admin logout\n/admin add <nama> <harga> <deskripsi>\n/admin del <id>\n/admin products\n/admin orders\n/cancel <order_id>\n/sync_indosmm\n/backup\n/listbackups\n/restore <filename>';
  else text += 'Admin: /admin <password>';
  bot.sendMessage(chatId, text, mainKb(isAdmin));
});

bot.onText(/^\/saldo$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const bal = getBalance(chatId);
  bot.sendMessage(chatId, `💰 Saldo Anda: Rp ${bal.toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
});

bot.onText(/^\/topup (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const amount = parseInt(match[1], 10);
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, 'Jumlah tidak valid. Contoh: /topup 10000', mainKb(admins.has(chatId)));
  if (amount < 5000) return bot.sendMessage(chatId, 'Minimal topup Rp 5.000', mainKb(admins.has(chatId)));
  const orderId = nextOrderId();
  const order = {
    id: orderId,
    user_id: chatId,
    product_id: -1,
    product_name: 'Top Up Saldo',
    price: amount,
    quantity: 1,
    total: amount,
    timestamp: new Date().toISOString(),
    status: 'awaiting_payment',
    pakasir_transaction_id: null,
    payment_number: null,
    voucher_code: null,
    discount: 0,
    total_after_discount: null,
    is_topup: true,
    topup_processed: false
  };
  orders.push(order);
  saveOrders();
  const pkgRes = await createPakasirTransaction(order);
  if (pkgRes && pkgRes.payment && pkgRes.payment.payment_number) {
    order.pakasir_transaction_id = orderId.toString();
    order.payment_number = pkgRes.payment.payment_number;
    saveOrders();
    try {
      const qrBuffer = await generateQRImage(order.payment_number);
      await bot.sendPhoto(chatId, qrBuffer, { caption: `🔋 Top Up Saldo\nNominal: Rp ${amount.toLocaleString('id-ID')}\nOrder #${orderId}\nScan QRIS untuk topup.`, reply_markup: mainKb(admins.has(chatId)) });
    } catch (e) {
      await bot.sendMessage(chatId, `🔋 Top Up Saldo\nNominal: Rp ${amount.toLocaleString('id-ID')}\nOrder #${orderId}\nPayment: ${order.payment_number}`, { reply_markup: mainKb(admins.has(chatId)) });
    }
    await notifyAdmins(`📢 Top Up request #${orderId}\nUser: ${chatId}\nNominal: Rp ${amount.toLocaleString('id-ID')}\nStatus: ${order.status}`);
  } else {
    order.status = 'cancelled';
    saveOrders();
    await bot.sendMessage(chatId, `⚠️ Gagal membuat topup. Silakan coba lagi.`, mainKb(admins.has(chatId)));
    await notifyAdmins(`⚠️ Top Up #${orderId} gagal dibuat.`);
  }
});

bot.onText(/^\/admin logout$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  admins.delete(chatId); saveAdmins();
  bot.sendMessage(chatId, 'Logged out.', mainKb(false));
});

bot.onText(/^\/admin (\d+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (match[1] === config.admin.password) {
    admins.add(chatId); saveAdmins();
    bot.sendMessage(chatId, '✅ Admin access granted.', mainKb(true));
  } else {
    bot.sendMessage(chatId, '❌ Password salah.', mainKb(false));
  }
});

bot.onText(/^\/admin add (.+) (\d+) (.*)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak. Login dulu.', mainKb(false));
  const name = match[1], price = parseInt(match[2], 10), desc = match[3];
  if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, 'Harga tidak valid.', adminKb());
  const newId = nextProductId();
  products.push({ id: newId, name, price, desc });
  saveProducts();
  bot.sendMessage(chatId, `✅ Produk ditambahkan: ${newId}. ${name} - Rp ${price.toLocaleString('id-ID')}`, adminKb());
});

bot.onText(/^\/admin del (\d+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const id = parseInt(match[1], 10);
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) return bot.sendMessage(chatId, `Produk ID ${id} tidak ditemukan.`, adminKb());
  const removed = products.splice(idx, 1)[0];
  saveProducts();
  bot.sendMessage(chatId, `✅ Produk dihapus: ${removed.name} (ID ${id})`, adminKb());
});

bot.onText(/^\/admin edit (\d+) (name|price|desc) (.+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const productId = parseInt(match[1], 10), field = match[2], value = match[3];
  const product = products.find(p => p.id === productId);
  if (!product) return bot.sendMessage(chatId, `Produk ID ${productId} tidak ditemukan.`, adminKb());
  if (field === 'price') {
    const price = parseInt(value, 10);
    if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, 'Harga tidak valid.', adminKb());
    product.price = price;
  } else if (field === 'name') product.name = value;
  else if (field === 'desc') product.desc = value;
  else return bot.sendMessage(chatId, 'Field tidak valid. Gunakan: name, price, desc', adminKb());
  saveProducts();
  bot.sendMessage(chatId, `✅ Produk diupdate:\n${product.id}. ${product.name} - Rp ${product.price.toLocaleString('id-ID')}\n${product.desc || ''}`, adminKb());
});

// Admin: Sync Indosmm services
bot.onText(/^\/sync_indosmm$/, async (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  if (!indosmm) return bot.sendMessage(chatId, 'Indosmm API tidak dikonfigurasi (config.json).', adminKb());
  bot.sendMessage(chatId, '⏳ Menyinkronkan layanan dari indosmm.id...');
  try {
    const services = await indosmm.getServices();
    if (!Array.isArray(services)) throw new Error('Respons tidak valid');
    let added = 0, updated = 0;
    for (const s of services) {
      const category = 'Suntik SMM';
      const existing = products.find(p => p.service === s.service);
      if (existing) {
        existing.name = s.name;
        existing.price = parseFloat(s.rate);
        existing.desc = `Category: ${s.category}\nMin: ${s.min}\nMax: ${s.max}\nRefill: ${s.refill ? 'Yes' : 'No'}\nCancel: ${s.cancel ? 'Yes' : 'No'}`;
        existing.category = category;
        updated++;
      } else {
        const newId = nextProductId();
        products.push({
          id: newId,
          name: s.name,
          price: parseFloat(s.rate),
          desc: `Category: ${s.category}\nMin: ${s.min}\nMax: ${s.max}\nRefill: ${s.refill ? 'Yes' : 'No'}\nCancel: ${s.cancel ? 'Yes' : 'No'}`,
          category: category,
          service: s.service
        });
        added++;
      }
    }
    saveProducts();
    bot.sendMessage(chatId, `✅ Sinkronisasi selesai.\n+${added} layanan baru\n~${updated} diperbarui\nTotal: ${products.length}`, adminKb());
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal sinkron: ${e.message}`, adminKb());
  }
});

// Admin Voucher commands
bot.onText(/^\/voucher add (\w+) (percent|fixed) (\d+)(?: (\d+))?(?: (\d+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const code = match[1].toUpperCase();
  const type = match[2];
  const value = parseInt(match[3], 10);
  const maxUsage = match[4] ? (match[4] === 'unlimited' ? Infinity : parseInt(match[4], 10)) : Infinity;
  const expireDays = match[5] ? parseInt(match[5], 10) : 30;
  if (isNaN(value) || value <= 0) return bot.sendMessage(chatId, 'Value tidak valid.', adminKb());
  if (maxUsage !== Infinity && (isNaN(maxUsage) || maxUsage <= 0)) return bot.sendMessage(chatId, 'Max usage harus angka positif atau "unlimited".', adminKb());
  if (expireDays <= 0) return bot.sendMessage(chatId, 'Expire days harus > 0.', adminKb());
  addVoucher(code, type, value, maxUsage, expireDays);
  bot.sendMessage(chatId, `✅ Voucher ${code} ditambahkan:\nType: ${type}\nValue: ${value}${type==='percent'?'%':''}\nMax usage: ${maxUsage===Infinity?'unlimited':maxUsage}\nExpire: ${expireDays} hari`, adminKb());
});

bot.onText(/^\/voucher list$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const entries = Object.entries(vouchers);
  if (!entries.length) return bot.sendMessage(chatId, 'Belum ada voucher.', adminKb());
  let list = '📋 Daftar Voucher:\n';
  entries.forEach(([code, v]) => {
    list += `${code}: ${v.type} ${v.value}${v.type==='percent'?'%':''} | used ${v.used_count}/${v.max_usage===Infinity?'∞':v.max_usage} | expire ${v.expire_days}d\n`;
  });
  bot.sendMessage(chatId, list, adminKb());
});

bot.onText(/^\/voucher del (\w+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const code = match[1].toUpperCase();
  if (!vouchers[code]) return bot.sendMessage(chatId, `Voucher ${code} tidak ditemukan.`, adminKb());
  deleteVoucher(code);
  bot.sendMessage(chatId, `✅ Voucher ${code} dihapus.`, adminKb());
});

bot.onText(/^\/cancel (\d+)$/, (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const id = parseInt(match[1], 10);
  const order = orders.find(o => o.id === id);
  if (!order) return bot.sendMessage(chatId, `Order #${id} tidak ditemukan.`, adminKb());
  if (order.status === 'paid') return bot.sendMessage(chatId, `Order #${id} sudah dibayar, tidak bisa dibatalkan.`, adminKb());
  order.status = 'cancelled';
  saveOrders();
  bot.sendMessage(chatId, `✅ Order #${id} dibatalkan.`, adminKb());
  try { bot.sendMessage(order.user_id, `📢 Order #${id} Anda dibatalkan oleh admin.`); } catch (e) {}
});

bot.onText(/^\/stats$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const uptimeMin = Math.floor((Date.now() - new Date(stats.startTime).getTime()) / 1000 / 60);
  const text = `📊 Statistik NEXBOT:\n🕐 Uptime: ${uptimeMin} menit\n📨 Total pesan: ${stats.totalMessages}\n💬 Teks: ${stats.totalText}\n🖼️ Gambar: ${stats.totalPhoto}\n🎭 Stiker: ${stats.totalSticker}`;
  bot.sendMessage(chatId, text, mainKb(admins.has(chatId)));
});

bot.onText(/^\/products$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!products.length) return bot.sendMessage(chatId, 'Katalog kosong.', mainKb(admins.has(chatId)));
  bot.sendMessage(chatId, 'Pilih kategori produk:', categoriesKb());
});

bot.onText(/^\/order (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++;
  const prodId = parseInt(match[1], 10);
  const product = products.find(p => p.id === prodId);
  if (!product) return bot.sendMessage(chatId, `Produk ID ${prodId} tidak ditemukan.`, mainKb(admins.has(chatId)));
  const orderId = nextOrderId();
  const order = { id: orderId, user_id: chatId, product_id: product.id, product_name: product.name, price: product.price, quantity: 1, total: product.price, timestamp: new Date().toISOString(), status: 'pending', pakasir_transaction_id: null, payment_number: null, voucher_code: null, discount: 0, total_after_discount: null };
  orders.push(order); saveOrders();
  bot.sendMessage(chatId, `Membuat pesanan untuk ${product.name}...`, mainKb(admins.has(chatId)));
  const pkgRes = await createPakasirTransaction(order);
  if (pkgRes && pkgRes.payment && pkgRes.payment.payment_number) {
    order.pakasir_transaction_id = orderId.toString();
    order.payment_number = pkgRes.payment.payment_number;
    order.status = 'awaiting_payment'; saveOrders();
    try {
      const qrBuffer = await generateQRImage(order.payment_number);
      await bot.sendPhoto(chatId, qrBuffer, { caption: `✅ Order #${orderId}\nProduk: ${product.name}\nQty: ${order.quantity}\nTotal: Rp ${order.total.toLocaleString('id-ID')}\nSilakan scan QRIS.`, reply_markup: orderDetailKb(order) });
    } catch (e) {
      await bot.sendMessage(chatId, `QRIS: ${order.payment_number}`, { reply_markup: orderDetailKb(order) });
    }
    await notifyAdmins(`📢 Order baru #${orderId}\nUser: ${chatId}\nProduk: ${product.name}\nTotal: Rp ${order.total.toLocaleString('id-ID')}\nStatus: ${order.status}`);
  } else {
    await bot.sendMessage(chatId, `⚠️ Gagal buat QRIS. Pesanan #${orderId} tercatat. Hubungi admin.`);
    await notifyAdmins(`⚠️ Order #${orderId} gagal dibuat QRIS.\nUser: ${chatId}\nProduk: ${product.name}\nManual handling needed.`);
  }
});

bot.onText(/^\/myorders$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const myOrders = orders.filter(o => o.user_id === chatId);
  if (!myOrders.length) return bot.sendMessage(chatId, 'Belum ada pesanan.', mainKb(admins.has(chatId)));
  let list = '📋 Pesanan Anda:\n';
  myOrders.forEach(o => {
    const displayTotal = o.total_after_discount || o.total;
    list += `#${o.id} ${o.product_name} - Rp ${displayTotal.toLocaleString('id-ID')} [${o.status}] Qty: ${o.quantity}\n`;
  });
  bot.sendMessage(chatId, list + '\nPilih order untuk detail:', {
    reply_markup: {
      inline_keyboard: myOrders.map(o => [{ text: `Order #${o.id} (${o.status})`, callback_data: `orderdetail_${o.id}` }]).concat([{ text: '🔙 Kembali', callback_data: 'start' }])
    }
  });
});

bot.onText(/^\/status (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const orderId = parseInt(match[1], 10);
  const order = orders.find(o => o.id === orderId && o.user_id === chatId);
  if (!order) return bot.sendMessage(chatId, 'Order tidak ditemukan.', mainKb(admins.has(chatId)));
  if (!order.pakasir_transaction_id) return bot.sendMessage(chatId, `Order #${orderId} belum terintegrasi. Status: ${order.status}`, mainKb(admins.has(chatId)));
  bot.sendMessage(chatId, `🔎 Mengecek status Order #${orderId}...`);
  const amountToCheck = order.total_after_discount || order.total;
  const res = await getPakasirTransaction(order.id, amountToCheck);
  if (res && res.transaction && res.transaction.status) {
    order.status = res.transaction.status;
    saveOrders();
    bot.sendMessage(chatId, `Status: ${order.status}\nOrder #${orderId} adalah "${order.status}"`);
  } else {
    bot.sendMessage(chatId, 'Gagal mengambil status dari Pakasir.');
  }
});

// User apply voucher via text (after inline button sets pending)
bot.onText(/^([A-Za-z0-9]+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].toUpperCase();
  const orderId = voucherPending[chatId];
  if (!orderId) return; // not waiting for voucher
  delete voucherPending[chatId];
  stats.totalMessages++; saveStats();
  const order = orders.find(o => o.id === orderId && o.user_id === chatId);
  if (!order) return bot.sendMessage(chatId, 'Order tidak ditemukan.', mainKb(admins.has(chatId)));
  const res = applyVoucher(order, code);
  if (res.ok) {
    bot.sendMessage(chatId, `✅ Voucher ${code} diterima!\nDiskon: Rp ${res.discount.toLocaleString('id-ID')}\nTotal setelah diskon: Rp ${res.total_after.toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
  } else {
    bot.sendMessage(chatId, `❌ Gagal: ${res.msg}`, mainKb(admins.has(chatId)));
  }
});

bot.onText(/^\/voucher (\w+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  const code = match[1].toUpperCase();
  const pendingOrders = orders.filter(o => o.user_id === chatId && ['pending','awaiting_payment'].includes(o.status)).sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp));
  if (!pendingOrders.length) return bot.sendMessage(chatId, 'Tidak ada order aktif untuk apply voucher.', mainKb(admins.has(chatId)));
  const order = pendingOrders[0];
  const res = applyVoucher(order, code);
  if (!res.ok) return bot.sendMessage(chatId, `Gagal: ${res.msg}`, mainKb(admins.has(chatId)));
  bot.sendMessage(chatId, `✅ Voucher ${code} diterima!\nDiskon: Rp ${res.discount.toLocaleString('id-ID')}\nTotal setelah diskon: Rp ${res.total_after.toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
});

bot.onText(/^\/backup$/, async (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  bot.sendMessage(chatId, '⏳ Membuat backup...');
  try {
    const zipPath = await createBackup();
    const filename = path.basename(zipPath);
    bot.sendMessage(chatId, `✅ Backup selesai: ${filename}\nUkuran: ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`, adminKb());
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal backup: ${e.message}`, adminKb());
  }
});

bot.onText(/^\/listbackups$/, (msg) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const files = listBackups();
  if (!files.length) return bot.sendMessage(chatId, 'Belum ada backup.', adminKb());
  let list = '📁 Backup Files:\n';
  files.forEach((f, i) => { const stat = fs.statSync(path.join(BACKUP_DIR, f)); list += `${i+1}. ${f} (${(stat.size/1024).toFixed(1)} KB)\n`; });
  bot.sendMessage(chatId, list + '\nGunakan /restore <filename> untuk restore.', adminKb());
});

bot.onText(/^\/restore (\S+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  stats.totalMessages++; saveStats();
  if (!admins.has(chatId)) return bot.sendMessage(chatId, 'Akses ditolak.', mainKb(false));
  const filename = match[1];
  bot.sendMessage(chatId, `⏳ Restoring ${filename}...`);
  try {
    await restoreBackup(filename);
    bot.sendMessage(chatId, `✅ Restore berhasil: ${filename}\nDatabase di-reload.`, adminKb());
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal restore: ${e.message}`, adminKb());
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.from && msg.from.username) {
    if (!users[chatId]) users[chatId] = {};
    users[chatId].username = msg.from.username;
    saveUsers();
  }
  if (msg.text && msg.text.startsWith('/')) return;
  stats.totalMessages++;

  // Handle Indosmm link input
  if (msg.text && linkPending[chatId]) {
    const orderId = linkPending[chatId];
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (order && order.status === 'pending') {
      const link = msg.text.trim();
      delete linkPending[chatId];
      order.target_link = link; // simpan sementara
      // Minta quantity
      quantityPending[chatId] = orderId;
      return bot.sendMessage(chatId, `Link diterima: ${link}\n\nBerapa quantity? (minimal 100)`, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'products' }]] }
      });
    }
  }

  // Handle Indosmm quantity input
  if (msg.text && quantityPending[chatId]) {
    const orderId = quantityPending[chatId];
    const order = orders.find(o => o.id === orderId && o.user_id === chatId);
    if (order && order.status === 'pending') {
      const qty = parseInt(msg.text.trim(), 10);
      if (isNaN(qty) || qty < 100) {
        return bot.sendMessage(chatId, 'Jumlah tidak valid. Minimal 100. Kirim angka quantity.', {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'products' }]] }
        });
      }
      delete quantityPending[chatId];
      // Hitung total dengan admin fee 20%
      const total = Math.ceil(order.price * qty * 1.2);
      // Cek saldo
      if (!deductBalance(chatId, total)) {
        order.status = 'cancelled';
        saveOrders();
        return bot.sendMessage(chatId, `❌ Saldo tidak cukup. Di butuh Rp ${total.toLocaleString('id-ID')}. Saldo Anda: Rp ${getBalance(chatId).toLocaleString('id-ID')}`, mainKb(admins.has(chatId)));
      }
      order.quantity = qty;
      order.total = total;
      saveOrders();
      // Create order via Indosmm
      const indosmmOrderId = await createIndosmmOrder(order, order.target_link);
      if (!indosmmOrderId) {
        order.status = 'cancelled';
        addBalance(chatId, total); // refund
        saveOrders();
        await notifyAdmins(`⚠️ Order #${orderId} gagal dibuat. Saldo Rp ${total} dikembalikan ke user ${formatUser(chatId)}.`);
        return bot.sendMessage(chatId, `❌ Gagal membuat order ke Indosmm. Kemungkinan:\n- Produk ini belum memiliki service ID (belum di-sync)\n- API key Indosmm tidak valid\n- Layanan Indosmm error\n\nOrder #${orderId} dibatalkan dan saldo Rp ${total} telah dikembalikan.`, mainKb(admins.has(chatId)));
      }
      order.indosmm_order_id = indosmmOrderId.toString();
      order.status = 'pending';
      saveOrders();
      await notifyAdmins(`📢 Order #${orderId} (Indosmm) dibuat.\nUser: ${formatUser(chatId)}\nProduk: ${order.product_name}\nQty: ${qty}\nTotal: Rp ${total.toLocaleString('id-ID')}\nLink: ${order.target_link}\nIndosmm Order ID: ${indosmmOrderId}\nStatus: ${order.status}`);
      return bot.sendMessage(chatId, `✅ Order #${orderId} diterima!\nProduk: ${order.product_name}\nQty: ${qty}\nTotal: Rp ${total.toLocaleString('id-ID')}\nStatus: ${order.status}\nLink: ${order.target_link}\n\nKamu bisa cek status dengan tombol "🔁 Cek Status" atau perintah /status ${orderId}`, orderDetailKb(order));
    }
  }

  if (msg.text) { stats.totalText++; bot.sendMessage(chatId, `Echo: ${msg.text}`); }
  else if (msg.photo) { stats.totalPhoto++; bot.sendMessage(chatId, 'Gambar diterima! 👍'); }
  else if (msg.sticker) { stats.totalSticker++; bot.sendMessage(chatId, 'Stiker diterima! 😄'); }
  else { bot.sendMessage(chatId, 'Pesan diterima! 👍'); }
  saveStats();
});

console.log('Bot JavaScript (voucher inline + edit photo + apply before QRIS) berjalan...');