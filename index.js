import { createClient } from '@libsql/client/web';

const WEB_APP_URL = 'https://webstarss.netlify.app';
const BOT_USERNAME = 'EliteStarsuzbot';
const WORKER_PUBLIC_URL = 'https://elite-stars.javohir-2010-49.workers.dev';
const DEFAULT_ADMIN_PASSWORD = '201049';
const DEFAULT_ADMIN_MAGIC = 'javohirweb';
const ADMIN_SESSION_SECONDS = 7 * 24 * 60 * 60;

let schemaReady = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      await ensureSchema(env);

      if (request.method === 'GET' && url.pathname === '/') {
        return new Response('Elite Stars Bot ishlayapti ✅', {
          headers: { 'content-type': 'text/plain; charset=UTF-8' },
        });
      }

      if (request.method === 'GET' && url.pathname === '/setup') {
        const webhookUrl = `${url.origin}/webhook`;
        const body = {
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false,
        };
        if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;

        const setWebhook = await tg(env, 'setWebhook', body);
        await tg(env, 'setMyCommands', {
          commands: [
            { command: 'start', description: 'Botni ishga tushirish' },
            { command: 'panel', description: 'Admin panel' },
            { command: 'logout', description: 'Admin paneldan chiqish' },
          ],
        });

        return json({ webhook: webhookUrl, telegram: setWebhook });
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        const info = await tg(env, 'getWebhookInfo');
        return json(info);
      }

      if (request.method === 'POST' && url.pathname === '/webhook') {
        if (env.WEBHOOK_SECRET) {
          const incoming = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
          if (incoming !== env.WEBHOOK_SECRET) {
            return new Response('Forbidden', { status: 403 });
          }
        }

        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, env, ctx).catch(console.error));
        return new Response('OK');
      }

      if (request.method === 'POST' && url.pathname === '/api/me') {
        return cors(await apiMe(request, env));
      }

      if (request.method === 'POST' && url.pathname === '/api/click') {
        return cors(await apiClick(request, env));
      }

      if (request.method === 'POST' && url.pathname === '/api/task/verify') {
        return cors(await apiTaskVerify(request, env));
      }

      if (request.method === 'POST' && url.pathname === '/partner/complete') {
        return await partnerComplete(request, env);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};

function db(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL yoki TURSO_AUTH_TOKEN sozlanmagan');
  }
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

async function ensureSchema(env) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const c = db(env);
    const statements = [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        tg_id TEXT PRIMARY KEY,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        phone TEXT,
        phone_verified INTEGER NOT NULL DEFAULT 0,
        banned INTEGER NOT NULL DEFAULT 0,
        balance INTEGER NOT NULL DEFAULT 0,
        total_earned INTEGER NOT NULL DEFAULT 0,
        total_clicks INTEGER NOT NULL DEFAULT 0,
        referrals_count INTEGER NOT NULL DEFAULT 0,
        pending_referrer_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS referrals (
        referred_tg_id TEXT PRIMARY KEY,
        referrer_tg_id TEXT NOT NULL,
        reward INTEGER NOT NULL DEFAULT 0,
        rewarded_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS required_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        check_chat TEXT,
        reward INTEGER NOT NULL DEFAULT 1,
        approval_mode TEXT NOT NULL DEFAULT 'manual',
        partner_secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS completed_tasks (
        task_id INTEGER NOT NULL,
        tg_id TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, tg_id)
      )`,
      `CREATE TABLE IF NOT EXISTS task_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        tg_id TEXT NOT NULL,
        screenshot_file_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS admin_sessions (
        tg_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS flows (
        tg_id TEXT PRIMARY KEY,
        flow TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS click_rate (
        tg_id TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
      `CREATE INDEX IF NOT EXISTS idx_submissions_status ON task_submissions(status)`,
    ];
    for (const sql of statements) await c.execute(sql);

    const defaults = {
      bot_enabled: '1',
      clicker_enabled: '1',
      click_target: '1000',
      click_reward: '1',
      referral_reward: '5',
    };
    for (const [key, value] of Object.entries(defaults)) {
      await c.execute({
        sql: 'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',
        args: [key, value],
      });
    }
  })();
  return schemaReady;
}

async function getSetting(env, key, fallback = null) {
  const r = await db(env).execute({ sql: 'SELECT value FROM settings WHERE key=?', args: [key] });
  return r.rows[0]?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await db(env).execute({
    sql: `INSERT INTO settings(key,value) VALUES(?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [key, String(value)],
  });
}

async function tg(env, method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.error('Telegram API', method, data);
  return data;
}

async function send(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCb(env, id, text = '', showAlert = false) {
  return tg(env, 'answerCallbackQuery', {
    callback_query_id: id,
    text,
    show_alert: showAlert,
  });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function esc(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function upsertUser(env, from, pendingRef = null) {
  if (!from?.id) return;
  const id = String(from.id);
  const t = now();
  const c = db(env);
  await c.execute({
    sql: `INSERT INTO users(tg_id,first_name,last_name,username,pending_referrer_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(tg_id) DO UPDATE SET
            first_name=excluded.first_name,
            last_name=excluded.last_name,
            username=excluded.username,
            updated_at=excluded.updated_at,
            pending_referrer_id=COALESCE(users.pending_referrer_id, excluded.pending_referrer_id)`,
    args: [
      id,
      from.first_name || '',
      from.last_name || '',
      from.username || '',
      pendingRef && String(pendingRef) !== id ? String(pendingRef) : null,
      t,
      t,
    ],
  });
}

async function getUser(env, tgId) {
  const r = await db(env).execute({ sql: 'SELECT * FROM users WHERE tg_id=?', args: [String(tgId)] });
  return r.rows[0] || null;
}

async function isBanned(env, tgId) {
  const u = await getUser(env, tgId);
  return Number(u?.banned || 0) === 1;
}

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) {
    return handleCallback(update.callback_query, env, ctx);
  }

  const m = update.message;
  if (!m) return;
  await upsertUser(env, m.from);

  if (m.text?.startsWith('/panel')) {
    return handlePanelCommand(m, env);
  }

  if (m.text?.startsWith('/logout')) {
    await db(env).execute({ sql: 'DELETE FROM admin_sessions WHERE tg_id=?', args: [String(m.from.id)] });
    await clearFlow(env, m.from.id);
    return send(env, m.chat.id, '✅ Admin paneldan chiqdingiz.');
  }

  const flow = await getFlow(env, m.from.id);
  if (flow) {
    const handled = await handleFlowMessage(m, flow, env);
    if (handled) return;
  }

  if (m.text?.startsWith('/start')) {
    return handleStart(m, env);
  }

  if (await isBanned(env, m.from.id)) {
    return send(env, m.chat.id, '🚫 Hisobingiz admin tomonidan bloklangan.');
  }

  if (m.contact) {
    return handleContact(m, env);
  }

  if (m.photo?.length) {
    const f = await getFlow(env, m.from.id);
    if (f?.flow === 'await_task_screenshot') return handleTaskScreenshot(m, f, env);
  }
}

async function handleStart(m, env) {
  const payload = (m.text || '').split(' ').slice(1).join(' ').trim();
  let pendingRef = null;
  if (payload.startsWith('ref_')) pendingRef = payload.slice(4);
  else if (/^\d+$/.test(payload)) pendingRef = payload;
  await upsertUser(env, m.from, pendingRef);

  if (payload.startsWith('task_')) {
    const taskId = Number(payload.slice(5));
    const user = await getUser(env, m.from.id);
    if (!user?.phone_verified) {
      await sendContactRequest(env, m.chat.id);
      return;
    }
    const task = await getTask(env, taskId);
    if (!task || !Number(task.enabled)) return send(env, m.chat.id, '❌ Bu vazifa topilmadi yoki o‘chirilgan.');
    if (task.approval_mode !== 'manual') return send(env, m.chat.id, 'ℹ️ Bu vazifa avtomatik tekshiriladi.');
    await setFlow(env, m.from.id, 'await_task_screenshot', { task_id: taskId });
    return send(env, m.chat.id, `📸 <b>${esc(task.title)}</b> vazifasi bajarilganini tasdiqlovchi screenshot yuboring.`);
  }

  if (await isBanned(env, m.from.id)) {
    return send(env, m.chat.id, '🚫 Hisobingiz admin tomonidan bloklangan.');
  }

  const user = await getUser(env, m.from.id);
  if (!Number(user?.phone_verified)) {
    return sendContactRequest(env, m.chat.id);
  }

  const enabled = await getSetting(env, 'bot_enabled', '1');
  if (enabled !== '1') {
    return send(env, m.chat.id, '🔒 <b>Botimiz vaqtinchalik o‘chirildi.</b>\n\nTexnik ishlar olib borilmoqda.');
  }

  return showSubscriptionGate(env, m.chat.id, m.from.id);
}

async function sendContactRequest(env, chatId) {
  const me = await tg(env, 'getMe');
  const botName = me.result?.first_name || 'Elite Stars';
  return send(
    env,
    chatId,
    `⭐ <b>${esc(botName)}</b> botiga xush kelibsiz!\n\nBotdan foydalanish uchun telefon raqamingizni tasdiqlang.\n\n🇺🇿 Faqat O‘zbekiston <b>+998</b> raqamli foydalanuvchilar foydalanishi mumkin.`,
    {
      reply_markup: {
        keyboard: [[{ text: '📱 Telefon raqamni yuborish', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
  );
}

async function handleContact(m, env) {
  if (m.contact.user_id && Number(m.contact.user_id) !== Number(m.from.id)) {
    return send(env, m.chat.id, '❌ Faqat o‘zingizning Telegram kontaktingizni yuboring.');
  }

  const phone = String(m.contact.phone_number || '').replace(/[^\d+]/g, '');
  const isUz = phone.startsWith('+998') || phone.startsWith('998');
  if (!isUz) {
    return send(env, m.chat.id, '❌ Faqat 🇺🇿 <b>+998</b> raqamlar qabul qilinadi.', {
      reply_markup: {
        keyboard: [[{ text: '📱 Qayta yuborish', request_contact: true }]],
        resize_keyboard: true,
      },
    });
  }

  await db(env).execute({
    sql: 'UPDATE users SET phone=?, phone_verified=1, updated_at=? WHERE tg_id=?',
    args: [phone, now(), String(m.from.id)],
  });
  await rewardReferralIfNeeded(env, m.from.id);

  await send(env, m.chat.id, '✅ Telefon raqamingiz tasdiqlandi.', {
    reply_markup: { remove_keyboard: true },
  });

  const enabled = await getSetting(env, 'bot_enabled', '1');
  if (enabled !== '1') {
    return send(env, m.chat.id, '🔒 Bot vaqtincha o‘chirilgan. Texnik ishlar olib borilmoqda.');
  }

  return showSubscriptionGate(env, m.chat.id, m.from.id);
}

async function rewardReferralIfNeeded(env, referredId) {
  const user = await getUser(env, referredId);
  const referrer = user?.pending_referrer_id;
  if (!referrer || String(referrer) === String(referredId)) return;

  const refUser = await getUser(env, referrer);
  if (!refUser) return;

  const reward = Number(await getSetting(env, 'referral_reward', '5')) || 0;
  const r = await db(env).execute({
    sql: 'INSERT OR IGNORE INTO referrals(referred_tg_id,referrer_tg_id,reward,rewarded_at) VALUES(?,?,?,?)',
    args: [String(referredId), String(referrer), reward, now()],
  });
  if (Number(r.rowsAffected || 0) > 0) {
    await db(env).execute({
      sql: `UPDATE users SET balance=balance+?, total_earned=total_earned+?, referrals_count=referrals_count+1, updated_at=? WHERE tg_id=?`,
      args: [reward, reward, now(), String(referrer)],
    });
    await send(env, referrer, `🎁 Yangi referal! Balansingizga <b>+${reward} ⭐</b> qo‘shildi.`);
  }
  await db(env).execute({ sql: 'UPDATE users SET pending_referrer_id=NULL WHERE tg_id=?', args: [String(referredId)] });
}

async function getRequiredChannels(env) {
  const r = await db(env).execute('SELECT * FROM required_channels WHERE enabled=1 ORDER BY id');
  return r.rows;
}

async function checkRequiredChannels(env, tgId) {
  const channels = await getRequiredChannels(env);
  const missing = [];
  for (const ch of channels) {
    const r = await tg(env, 'getChatMember', { chat_id: ch.chat_ref, user_id: Number(tgId) });
    const st = r.result?.status;
    const ok = r.ok && (['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && r.result?.is_member));
    if (!ok) missing.push(ch);
  }
  return { ok: missing.length === 0, channels, missing };
}

async function showSubscriptionGate(env, chatId, tgId) {
  const check = await checkRequiredChannels(env, tgId);
  if (check.channels.length === 0 || check.ok) return sendWebAppButton(env, chatId);

  const buttons = check.channels.map((ch) => [{ text: `📢 ${ch.title}`, url: ch.url }]);
  buttons.push([{ text: '✅ Obunani tekshirish', callback_data: 'check_required' }]);
  return send(env, chatId, '📢 <b>Majburiy kanallarga obuna bo‘ling</b> va keyin “Tekshirish” tugmasini bosing.', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendWebAppButton(env, chatId) {
  return send(env, chatId, '⭐ Botimizdan foydalanish uchun <b>Web Panel</b>ga kiring:', {
    reply_markup: {
      inline_keyboard: [[{ text: '🌐 Web Appga kirish', web_app: { url: WEB_APP_URL } }]],
    },
  });
}

async function handleCallback(q, env, ctx) {
  const data = q.data || '';
  const userId = q.from.id;
  await upsertUser(env, q.from);

  if (data === 'check_required') {
    const chk = await checkRequiredChannels(env, userId);
    if (!chk.ok) {
      const names = chk.missing.map((x) => x.title).join(', ');
      return answerCb(env, q.id, `Hali obuna bo‘lmagansiz: ${names}`, true);
    }
    await answerCb(env, q.id, '✅ Tasdiqlandi');
    return sendWebAppButton(env, q.message.chat.id);
  }

  if (!data.startsWith('admin:')) return;
  const ok = await isAdminSession(env, userId);
  if (!ok) return answerCb(env, q.id, 'Admin sessiya tugagan. /panel yuboring.', true);

  await answerCb(env, q.id);
  return handleAdminCallback(q, env, ctx);
}

async function handlePanelCommand(m, env) {
  if (await isAdminSession(env, m.from.id)) return showAdminMenu(env, m.chat.id);
  await setFlow(env, m.from.id, 'admin_password', {});
  return send(env, m.chat.id, '🔐 Admin panel parolini kiriting:');
}

async function isAdminSession(env, tgId) {
  const r = await db(env).execute({ sql: 'SELECT expires_at FROM admin_sessions WHERE tg_id=?', args: [String(tgId)] });
  const exp = Number(r.rows[0]?.expires_at || 0);
  if (exp > now()) return true;
  if (exp) await db(env).execute({ sql: 'DELETE FROM admin_sessions WHERE tg_id=?', args: [String(tgId)] });
  return false;
}

async function createAdminSession(env, tgId) {
  await db(env).execute({
    sql: `INSERT INTO admin_sessions(tg_id,expires_at) VALUES(?,?)
          ON CONFLICT(tg_id) DO UPDATE SET expires_at=excluded.expires_at`,
    args: [String(tgId), now() + ADMIN_SESSION_SECONDS],
  });
}

async function showAdminMenu(env, chatId) {
  return send(env, chatId, '👑 <b>Elite Stars — Admin Panel</b>\n\nKerakli bo‘limni tanlang:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⭐ Clicker sozlamalari', callback_data: 'admin:clicker' }],
        [{ text: '🎯 Vazifalar', callback_data: 'admin:tasks' }],
        [{ text: '📢 Majburiy kanallar', callback_data: 'admin:channels' }],
        [{ text: '👥 Foydalanuvchilar', callback_data: 'admin:users' }],
        [{ text: '🎁 Referal sozlamasi', callback_data: 'admin:referral' }],
        [{ text: '📊 Statistika', callback_data: 'admin:stats' }],
        [{ text: '🤖 Botni yoqish/o‘chirish', callback_data: 'admin:bot' }],
      ],
    },
  });
}

async function handleAdminCallback(q, env, ctx) {
  const d = q.data;
  const chatId = q.message.chat.id;
  const adminId = q.from.id;

  if (d === 'admin:menu') return showAdminMenu(env, chatId);

  if (d === 'admin:clicker') {
    const enabled = await getSetting(env, 'clicker_enabled', '1');
    const target = await getSetting(env, 'click_target', '1000');
    const reward = await getSetting(env, 'click_reward', '1');
    return send(env, chatId, `⭐ <b>Clicker</b>\n\nHolat: ${enabled === '1' ? '✅ Yoqilgan' : '🔒 O‘chirilgan'}\n${target} click = ${reward} ⭐`, {
      reply_markup: { inline_keyboard: [
        [{ text: enabled === '1' ? '🔒 O‘chirish' : '✅ Yoqish', callback_data: 'admin:clicker:toggle' }],
        [{ text: '✏️ Click miqdorini sozlash', callback_data: 'admin:clicker:set' }],
        [{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }],
      ] },
    });
  }

  if (d === 'admin:clicker:toggle') {
    const cur = await getSetting(env, 'clicker_enabled', '1');
    await setSetting(env, 'clicker_enabled', cur === '1' ? '0' : '1');
    return handleAdminCallback({ ...q, data: 'admin:clicker' }, env, ctx);
  }

  if (d === 'admin:clicker:set') {
    await setFlow(env, adminId, 'admin_click_target', {});
    return send(env, chatId, '🔢 Nechta clickdan keyin mukofot berilsin? Masalan: <b>1000</b>');
  }

  if (d === 'admin:referral') {
    const reward = await getSetting(env, 'referral_reward', '5');
    return send(env, chatId, `🎁 Hozirgi referal bonusi: <b>${reward} ⭐</b>`, {
      reply_markup: { inline_keyboard: [
        [{ text: '✏️ Bonusni o‘zgartirish', callback_data: 'admin:referral:set' }],
        [{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }],
      ] },
    });
  }

  if (d === 'admin:referral:set') {
    await setFlow(env, adminId, 'admin_referral_reward', {});
    return send(env, chatId, '🎁 Har bir tasdiqlangan referal uchun nechta ⭐ berilsin?');
  }

  if (d === 'admin:bot') {
    const enabled = await getSetting(env, 'bot_enabled', '1');
    return send(env, chatId, `🤖 Bot holati: ${enabled === '1' ? '✅ Ishlayapti' : '🔒 O‘chirilgan'}`, {
      reply_markup: { inline_keyboard: [
        [{ text: enabled === '1' ? '🔒 Botni o‘chirish' : '✅ Botni yoqish', callback_data: 'admin:bot:toggle' }],
        [{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }],
      ] },
    });
  }

  if (d === 'admin:bot:toggle') {
    const cur = await getSetting(env, 'bot_enabled', '1');
    const next = cur === '1' ? '0' : '1';
    await setSetting(env, 'bot_enabled', next);
    const text = next === '1'
      ? '✅ Bot ishga tushdi. Bemalol Stars ishlashingiz mumkin!'
      : '🔒 Botimiz vaqtinchalik o‘chirildi. Texnik ishlar olib borilmoqda.';
    ctx.waitUntil(broadcast(env, text));
    await send(env, chatId, next === '1' ? '✅ Bot yoqildi.' : '🔒 Bot o‘chirildi.');
    return;
  }

  if (d === 'admin:stats') {
    const c = db(env);
    const [u, b, e, clicks, refs, done] = await Promise.all([
      c.execute('SELECT COUNT(*) n FROM users'),
      c.execute('SELECT COALESCE(SUM(balance),0) n FROM users'),
      c.execute('SELECT COALESCE(SUM(total_earned),0) n FROM users'),
      c.execute('SELECT COALESCE(SUM(total_clicks),0) n FROM users'),
      c.execute('SELECT COUNT(*) n FROM referrals'),
      c.execute('SELECT COUNT(*) n FROM completed_tasks'),
    ]);
    return send(env, chatId,
      `📊 <b>Statistika</b>\n\n👥 Userlar: <b>${u.rows[0].n}</b>\n⭐ Jami balans: <b>${b.rows[0].n}</b>\n💰 Jami ishlangan: <b>${e.rows[0].n}</b>\n👆 Jami click: <b>${clicks.rows[0].n}</b>\n🎁 Referallar: <b>${refs.rows[0].n}</b>\n✅ Bajarilgan vazifalar: <b>${done.rows[0].n}</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }]] } },
    );
  }

  if (d === 'admin:users') {
    await setFlow(env, adminId, 'admin_user_search', {});
    return send(env, chatId, '👥 Userning Telegram ID yoki @username’ini yuboring:');
  }

  if (d.startsWith('admin:user:')) {
    const [, , action, tgId] = d.split(':');
    if (action === 'ban' || action === 'unban') {
      await db(env).execute({ sql: 'UPDATE users SET banned=?, updated_at=? WHERE tg_id=?', args: [action === 'ban' ? 1 : 0, now(), tgId] });
      return showAdminUser(env, chatId, tgId);
    }
    if (action === 'add') {
      await setFlow(env, adminId, 'admin_user_add_stars', { tg_id: tgId });
      return send(env, chatId, '➕ Nechta ⭐ qo‘shilsin?');
    }
    if (action === 'sub') {
      await setFlow(env, adminId, 'admin_user_sub_stars', { tg_id: tgId });
      return send(env, chatId, '➖ Nechta ⭐ olinsin?');
    }
  }

  if (d === 'admin:channels') return showChannelsAdmin(env, chatId);
  if (d === 'admin:channel:add') {
    await setFlow(env, adminId, 'admin_channel_add', {});
    return send(env, chatId, '📢 Kanal username yoki linkini yuboring. Masalan: <code>@kanalim</code> yoki <code>https://t.me/kanalim</code>\n\n⚠️ Bot kanalda admin bo‘lishi kerak.');
  }
  if (d.startsWith('admin:channel:toggle:')) {
    const id = Number(d.split(':').pop());
    await db(env).execute({ sql: 'UPDATE required_channels SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?', args: [id] });
    return showChannelsAdmin(env, chatId);
  }
  if (d.startsWith('admin:channel:delete:')) {
    const id = Number(d.split(':').pop());
    await db(env).execute({ sql: 'DELETE FROM required_channels WHERE id=?', args: [id] });
    return showChannelsAdmin(env, chatId);
  }

  if (d === 'admin:tasks') return showTasksAdmin(env, chatId);
  if (d === 'admin:task:add') {
    return send(env, chatId, '🎯 Vazifa turini tanlang:', {
      reply_markup: { inline_keyboard: [
        [{ text: '🤖 Telegram bot', callback_data: 'admin:task:type:bot' }],
        [{ text: '📢 Telegram kanal', callback_data: 'admin:task:type:channel' }],
        [{ text: '👥 Telegram guruh', callback_data: 'admin:task:type:group' }],
        [{ text: '⬅️ Orqaga', callback_data: 'admin:tasks' }],
      ] },
    });
  }
  if (d.startsWith('admin:task:type:')) {
    const type = d.split(':').pop();
    await setFlow(env, adminId, 'admin_task_link', { type });
    return send(env, chatId, '🔗 Vazifa havolasini yuboring:');
  }
  if (d === 'admin:task:list') return showTaskList(env, chatId);
  if (d === 'admin:task:pending') return showPendingSubmission(env, chatId);
  if (d === 'admin:task:mode:auto' || d === 'admin:task:mode:manual') {
    const mode = d.endsWith(':auto') ? 'auto' : 'manual';
    const saved = await saveTaskFromFlow(env, adminId, mode);
    if (!saved) return send(env, chatId, '❌ Vazifa yaratish jarayoni topilmadi. Qaytadan boshlang.');
    if (saved.error) return send(env, chatId, `❌ ${esc(saved.error)}`);
    let text = `✅ Vazifa saqlandi. ID: <b>#${saved.id}</b>`;
    if (saved.partnerSecret) {
      text += `\n\n🤖 <b>Hamkor bot auto-tasdiqlashi uchun:</b>\nEndpoint: <code>${WORKER_PUBLIC_URL}/partner/complete</code>\nTask ID: <code>${saved.id}</code>\nSecret: <code>${saved.partnerSecret}</code>\n\nHamkor bot POST JSON yuboradi: <code>{\"task_id\":${saved.id},\"user_id\":123,\"secret\":\"...\"}</code>`;
    }
    await send(env, chatId, text);
    return showTasksAdmin(env, chatId);
  }
  if (d.startsWith('admin:task:toggle:')) {
    const id = Number(d.split(':').pop());
    await db(env).execute({ sql: 'UPDATE tasks SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?', args: [id] });
    return showTaskList(env, chatId);
  }
  if (d.startsWith('admin:task:delete:')) {
    const id = Number(d.split(':').pop());
    await db(env).execute({ sql: 'DELETE FROM tasks WHERE id=?', args: [id] });
    return showTaskList(env, chatId);
  }
  if (d.startsWith('admin:submission:approve:') || d.startsWith('admin:submission:reject:')) {
    const parts = d.split(':');
    const action = parts[2];
    const id = Number(parts[3]);
    const r = await db(env).execute({ sql: 'SELECT * FROM task_submissions WHERE id=?', args: [id] });
    const sub = r.rows[0];
    if (!sub || sub.status !== 'pending') return send(env, chatId, 'Bu ariza allaqachon ko‘rib chiqilgan.');
    const task = await getTask(env, sub.task_id);
    if (action === 'approve') {
      const awarded = await completeTask(env, task, sub.tg_id);
      await db(env).execute({ sql: "UPDATE task_submissions SET status='approved', reviewed_at=? WHERE id=?", args: [now(), id] });
      await send(env, sub.tg_id, awarded ? `✅ Vazifangiz tasdiqlandi. +${task.reward} ⭐` : '✅ Vazifa tasdiqlandi.');
    } else {
      await db(env).execute({ sql: "UPDATE task_submissions SET status='rejected', reviewed_at=? WHERE id=?", args: [now(), id] });
      await send(env, sub.tg_id, '❌ Vazifa uchun yuborgan screenshot rad etildi.');
    }
    return showPendingSubmission(env, chatId);
  }
}

async function handleFlowMessage(m, flow, env) {
  const id = m.from.id;
  const chatId = m.chat.id;
  const text = (m.text || '').trim();
  const data = flow.data || {};

  if (flow.flow === 'admin_password') {
    const pass = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    if (text !== pass) {
      await send(env, chatId, '❌ Parol noto‘g‘ri. Qayta kiriting:');
      return true;
    }
    await setFlow(env, id, 'admin_magic', {});
    await send(env, chatId, '✨ Sehrli so‘zni kiriting:');
    return true;
  }

  if (flow.flow === 'admin_magic') {
    const magic = env.ADMIN_MAGIC || DEFAULT_ADMIN_MAGIC;
    if (text !== magic) {
      await send(env, chatId, '❌ Sehrli so‘z noto‘g‘ri. Qayta kiriting:');
      return true;
    }
    await createAdminSession(env, id);
    await clearFlow(env, id);
    await send(env, chatId, '✅ Admin panelga kirildi.');
    await showAdminMenu(env, chatId);
    return true;
  }

  if (!(await isAdminSession(env, id)) && flow.flow.startsWith('admin_')) {
    await clearFlow(env, id);
    await send(env, chatId, 'Admin sessiya tugagan. /panel yuboring.');
    return true;
  }

  if (flow.flow === 'admin_click_target') {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 100000000) {
      await send(env, chatId, '❌ Musbat butun son yuboring.');
      return true;
    }
    await setFlow(env, id, 'admin_click_reward', { target: n });
    await send(env, chatId, `✅ ${n} click. Endi shu miqdorga yetganda beriladigan ⭐ sonini yuboring:`);
    return true;
  }

  if (flow.flow === 'admin_click_reward') {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 1000000) {
      await send(env, chatId, '❌ Musbat butun son yuboring.');
      return true;
    }
    await setSetting(env, 'click_target', data.target);
    await setSetting(env, 'click_reward', n);
    await clearFlow(env, id);
    await send(env, chatId, `✅ Saqlandi: <b>${data.target} click = ${n} ⭐</b>`);
    await showAdminMenu(env, chatId);
    return true;
  }

  if (flow.flow === 'admin_referral_reward') {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) {
      await send(env, chatId, '❌ 0 yoki undan katta butun son yuboring.');
      return true;
    }
    await setSetting(env, 'referral_reward', n);
    await clearFlow(env, id);
    await send(env, chatId, `✅ Referal bonusi ${n} ⭐ qilib saqlandi.`);
    return true;
  }

  if (flow.flow === 'admin_user_search') {
    let u = null;
    if (/^\d+$/.test(text)) u = await getUser(env, text);
    else {
      const username = text.replace(/^@/, '').toLowerCase();
      const r = await db(env).execute({ sql: 'SELECT * FROM users WHERE lower(username)=? LIMIT 1', args: [username] });
      u = r.rows[0] || null;
    }
    if (!u) {
      await send(env, chatId, '❌ User topilmadi. ID yoki @username’ni qayta yuboring:');
      return true;
    }
    await clearFlow(env, id);
    await showAdminUser(env, chatId, u.tg_id);
    return true;
  }

  if (flow.flow === 'admin_user_add_stars' || flow.flow === 'admin_user_sub_stars') {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 100000000) {
      await send(env, chatId, '❌ Musbat butun son yuboring.');
      return true;
    }
    const delta = flow.flow === 'admin_user_add_stars' ? n : -n;
    await db(env).execute({
      sql: 'UPDATE users SET balance=MAX(0,balance+?), updated_at=? WHERE tg_id=?',
      args: [delta, now(), data.tg_id],
    });
    await clearFlow(env, id);
    await showAdminUser(env, chatId, data.tg_id);
    return true;
  }

  if (flow.flow === 'admin_channel_add') {
    const parsed = parseTelegramTarget(text);
    if (!parsed) {
      await send(env, chatId, '❌ @username yoki https://t.me/username formatida yuboring.');
      return true;
    }
    const info = await tg(env, 'getChat', { chat_id: parsed.chatRef });
    if (!info.ok) {
      await send(env, chatId, '❌ Kanal topilmadi. Botni kanalga admin qilib, username/linkni qayta yuboring.');
      return true;
    }
    const title = info.result.title || parsed.chatRef;
    const url = parsed.url;
    await db(env).execute({
      sql: 'INSERT INTO required_channels(chat_ref,title,url,enabled,created_at) VALUES(?,?,?,?,?)',
      args: [parsed.chatRef, title, url, 1, now()],
    });
    await clearFlow(env, id);
    await send(env, chatId, `✅ Majburiy kanal qo‘shildi: <b>${esc(title)}</b>`);
    await showChannelsAdmin(env, chatId);
    return true;
  }

  if (flow.flow === 'admin_task_link') {
    await setFlow(env, id, 'admin_task_title', { ...data, link: text });
    await send(env, chatId, '📝 Vazifa nomi/izohini yuboring. Masalan: <b>Kanalga obuna bo‘ling</b>');
    return true;
  }

  if (flow.flow === 'admin_task_title') {
    await setFlow(env, id, 'admin_task_reward', { ...data, title: text || 'Telegram vazifasi' });
    await send(env, chatId, '⭐ Vazifa uchun mukofot miqdorini yuboring:');
    return true;
  }

  if (flow.flow === 'admin_task_reward') {
    const reward = Number(text);
    if (!Number.isInteger(reward) || reward < 0 || reward > 1000000) {
      await send(env, chatId, '❌ 0 yoki undan katta butun son yuboring.');
      return true;
    }
    await setFlow(env, id, 'admin_task_mode', { ...data, reward });
    const note = data.type === 'bot' ? '\n\nℹ️ Telegram bot vazifasini haqiqiy avtomatik tekshirish uchun hamkor bot /partner/complete API’ga tasdiq yuborishi kerak.' : '';
    await send(env, chatId, `✅ Mukofot: ${reward} ⭐. Tasdiqlash turini tanlang:${note}`, {
      reply_markup: { inline_keyboard: [
        [{ text: '⚡ Avtomatik', callback_data: 'admin:task:mode:auto' }],
        [{ text: '✋ Qo‘lda (screenshot)', callback_data: 'admin:task:mode:manual' }],
      ] },
    });
    return true;
  }

  if (flow.flow === 'await_task_screenshot' && m.photo?.length) {
    return handleTaskScreenshot(m, flow, env).then(() => true);
  }

  return false;
}

async function getFlow(env, tgId) {
  const r = await db(env).execute({ sql: 'SELECT flow,data FROM flows WHERE tg_id=?', args: [String(tgId)] });
  const row = r.rows[0];
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch {}
  return { flow: row.flow, data };
}

async function setFlow(env, tgId, flow, data = {}) {
  await db(env).execute({
    sql: `INSERT INTO flows(tg_id,flow,data,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(tg_id) DO UPDATE SET flow=excluded.flow,data=excluded.data,updated_at=excluded.updated_at`,
    args: [String(tgId), flow, JSON.stringify(data), now()],
  });
}

async function clearFlow(env, tgId) {
  await db(env).execute({ sql: 'DELETE FROM flows WHERE tg_id=?', args: [String(tgId)] });
}

async function showAdminUser(env, chatId, tgId) {
  const u = await getUser(env, tgId);
  if (!u) return send(env, chatId, 'User topilmadi.');
  return send(env, chatId,
    `👤 <b>${esc(u.first_name || '')} ${esc(u.last_name || '')}</b>\n@${esc(u.username || 'username_yoq')}\nID: <code>${u.tg_id}</code>\n\n⭐ Balans: <b>${u.balance}</b>\n💰 Jami ishlangan: <b>${u.total_earned}</b>\n👆 Click: <b>${u.total_clicks}</b>\n🎁 Referal: <b>${u.referrals_count}</b>\n📱 Tasdiq: ${Number(u.phone_verified) ? '✅' : '❌'}\n🚫 Ban: ${Number(u.banned) ? 'Ha' : 'Yo‘q'}`,
    { reply_markup: { inline_keyboard: [
      [{ text: '➕ Stars qo‘shish', callback_data: `admin:user:add:${u.tg_id}` }, { text: '➖ Stars olish', callback_data: `admin:user:sub:${u.tg_id}` }],
      [{ text: Number(u.banned) ? '✅ Bandan olish' : '🚫 Ban qilish', callback_data: `admin:user:${Number(u.banned) ? 'unban' : 'ban'}:${u.tg_id}` }],
      [{ text: '⬅️ Admin menu', callback_data: 'admin:menu' }],
    ] } },
  );
}

async function showChannelsAdmin(env, chatId) {
  const r = await db(env).execute('SELECT * FROM required_channels ORDER BY id DESC LIMIT 20');
  const rows = r.rows;
  const buttons = [[{ text: '➕ Kanal qo‘shish', callback_data: 'admin:channel:add' }]];
  for (const ch of rows) {
    buttons.push([
      { text: `${Number(ch.enabled) ? '✅' : '🔒'} ${String(ch.title).slice(0, 20)}`, callback_data: `admin:channel:toggle:${ch.id}` },
      { text: '🗑', callback_data: `admin:channel:delete:${ch.id}` },
    ]);
  }
  buttons.push([{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }]);
  return send(env, chatId, `📢 <b>Majburiy kanallar</b>\n\nJami: ${rows.length}`, { reply_markup: { inline_keyboard: buttons } });
}

async function showTasksAdmin(env, chatId) {
  return send(env, chatId, '🎯 <b>Vazifalar boshqaruvi</b>', {
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Vazifa qo‘shish', callback_data: 'admin:task:add' }],
      [{ text: '📋 Vazifalar ro‘yxati', callback_data: 'admin:task:list' }],
      [{ text: '🕐 Bajarilgan / kutilayotgan', callback_data: 'admin:task:pending' }],
      [{ text: '⬅️ Orqaga', callback_data: 'admin:menu' }],
    ] },
  });
}

async function showTaskList(env, chatId) {
  const r = await db(env).execute('SELECT * FROM tasks ORDER BY id DESC LIMIT 20');
  const buttons = [];
  for (const t of r.rows) {
    buttons.push([
      { text: `${Number(t.enabled) ? '✅' : '🔒'} #${t.id} ${String(t.title).slice(0, 16)}`, callback_data: `admin:task:toggle:${t.id}` },
      { text: '🗑', callback_data: `admin:task:delete:${t.id}` },
    ]);
  }
  buttons.push([{ text: '⬅️ Vazifalar', callback_data: 'admin:tasks' }]);
  return send(env, chatId, `📋 <b>Vazifalar</b>\n\n${r.rows.length ? 'Tugma bosib yoqish/o‘chirish mumkin.' : 'Hozircha vazifa yo‘q.'}`, { reply_markup: { inline_keyboard: buttons } });
}

async function showPendingSubmission(env, chatId) {
  const r = await db(env).execute(`SELECT s.*, t.title, t.reward FROM task_submissions s JOIN tasks t ON t.id=s.task_id WHERE s.status='pending' ORDER BY s.id LIMIT 1`);
  const s = r.rows[0];
  if (!s) return send(env, chatId, '✅ Hozircha kutilayotgan screenshot yo‘q.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Vazifalar', callback_data: 'admin:tasks' }]] } });
  const u = await getUser(env, s.tg_id);
  const caption = `🕐 <b>Vazifa tekshiruvi</b>\n\nUser: ${esc(u?.first_name || '')} @${esc(u?.username || '')}\nID: <code>${s.tg_id}</code>\nVazifa: <b>${esc(s.title)}</b>\nMukofot: <b>${s.reward} ⭐</b>`;
  const markup = { inline_keyboard: [[
    { text: '✅ Qabul qilish', callback_data: `admin:submission:approve:${s.id}` },
    { text: '❌ Rad etish', callback_data: `admin:submission:reject:${s.id}` },
  ]] };
  if (s.screenshot_file_id) {
    return tg(env, 'sendPhoto', { chat_id: chatId, photo: s.screenshot_file_id, caption, parse_mode: 'HTML', reply_markup: markup });
  }
  return send(env, chatId, caption, { reply_markup: markup });
}

async function handleTaskScreenshot(m, flow, env) {
  const taskId = Number(flow.data.task_id);
  const task = await getTask(env, taskId);
  if (!task) {
    await clearFlow(env, m.from.id);
    return send(env, m.chat.id, '❌ Vazifa topilmadi.');
  }
  const exists = await db(env).execute({ sql: 'SELECT 1 FROM completed_tasks WHERE task_id=? AND tg_id=?', args: [taskId, String(m.from.id)] });
  if (exists.rows.length) {
    await clearFlow(env, m.from.id);
    return send(env, m.chat.id, '✅ Siz bu vazifani oldin bajargansiz.');
  }
  const fileId = m.photo[m.photo.length - 1].file_id;
  await db(env).execute({
    sql: `INSERT INTO task_submissions(task_id,tg_id,screenshot_file_id,status,created_at)
          VALUES(?,?,?,'pending',?)`,
    args: [taskId, String(m.from.id), fileId, now()],
  });
  await clearFlow(env, m.from.id);
  return send(env, m.chat.id, '✅ Screenshot yuborildi. Admin tekshirganidan keyin natija keladi.');
}

async function getTask(env, id) {
  const r = await db(env).execute({ sql: 'SELECT * FROM tasks WHERE id=?', args: [Number(id)] });
  return r.rows[0] || null;
}

function parseTelegramTarget(input) {
  const s = String(input || '').trim();
  if (/^@[A-Za-z0-9_]{5,}$/.test(s)) {
    return { chatRef: s, url: `https://t.me/${s.slice(1)}` };
  }
  const m = s.match(/^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,})\/?$/i);
  if (m) return { chatRef: `@${m[1]}`, url: `https://t.me/${m[1]}` };
  return null;
}

async function saveTaskFromFlow(env, adminId, mode) {
  const f = await getFlow(env, adminId);
  if (!f || f.flow !== 'admin_task_mode') return null;
  const data = f.data;
  const parsed = parseTelegramTarget(data.link);
  let checkChat = null;
  if ((data.type === 'channel' || data.type === 'group') && mode === 'auto') {
    if (!parsed) return { error: 'Avtomatik kanal/guruh tekshiruvi uchun public @username yoki t.me/username link kerak.' };
    checkChat = parsed.chatRef;
  }
  const partnerSecret = data.type === 'bot' && mode === 'auto' ? crypto.randomUUID().replaceAll('-', '') : null;
  const r = await db(env).execute({
    sql: `INSERT INTO tasks(type,title,link,check_chat,reward,approval_mode,partner_secret,enabled,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
    args: [data.type, data.title, data.link, checkChat, data.reward, mode, partnerSecret, 1, now()],
  });
  await clearFlow(env, adminId);
  return { id: Number(r.lastInsertRowid), partnerSecret };
}

async function completeTask(env, task, tgId) {
  const ins = await db(env).execute({
    sql: 'INSERT OR IGNORE INTO completed_tasks(task_id,tg_id,completed_at) VALUES(?,?,?)',
    args: [Number(task.id), String(tgId), now()],
  });
  if (Number(ins.rowsAffected || 0) === 0) return false;
  await db(env).execute({
    sql: 'UPDATE users SET balance=balance+?, total_earned=total_earned+?, updated_at=? WHERE tg_id=?',
    args: [Number(task.reward), Number(task.reward), now(), String(tgId)],
  });
  return true;
}

async function broadcast(env, text) {
  const r = await db(env).execute('SELECT tg_id FROM users WHERE banned=0 ORDER BY created_at DESC LIMIT 1000');
  const ids = r.rows.map((x) => x.tg_id);
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    await Promise.allSettled(batch.map((id) => send(env, id, text)));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function apiMe(request, env) {
  const body = await request.json();
  const auth = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const userId = String(auth.user.id);
  await upsertUser(env, auth.user);
  const user = await getUser(env, userId);
  if (Number(user.banned)) return json({ ok: false, banned: true, error: 'Hisob bloklangan' }, 403);
  const botEnabled = (await getSetting(env, 'bot_enabled', '1')) === '1';
  const clickerEnabled = (await getSetting(env, 'clicker_enabled', '1')) === '1';
  const clickTarget = Number(await getSetting(env, 'click_target', '1000'));
  const clickReward = Number(await getSetting(env, 'click_reward', '1'));
  const referralReward = Number(await getSetting(env, 'referral_reward', '5'));
  const channels = await checkRequiredChannels(env, userId);

  const taskRows = await db(env).execute({
    sql: `SELECT t.*, CASE WHEN c.task_id IS NULL THEN 0 ELSE 1 END AS completed
          FROM tasks t
          LEFT JOIN completed_tasks c ON c.task_id=t.id AND c.tg_id=?
          WHERE t.enabled=1 ORDER BY t.id DESC`,
    args: [userId],
  });

  return json({
    ok: true,
    verified: Number(user.phone_verified) === 1,
    subscribed: channels.ok,
    missing_channels: channels.missing.map((x) => ({ title: x.title, url: x.url })),
    config: {
      bot_enabled: botEnabled,
      clicker_enabled: clickerEnabled,
      click_target: clickTarget,
      click_reward: clickReward,
      referral_reward: referralReward,
      bot_username: BOT_USERNAME,
    },
    user: publicUser(user),
    tasks: taskRows.rows.map((t) => ({
      id: Number(t.id),
      type: t.type,
      title: t.title,
      link: t.link,
      reward: Number(t.reward),
      approval_mode: t.approval_mode,
      completed: Number(t.completed) === 1,
    })),
  });
}

async function apiClick(request, env) {
  const body = await request.json();
  const auth = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const tgId = String(auth.user.id);
  await upsertUser(env, auth.user);
  const user = await getUser(env, tgId);
  if (!user || !Number(user.phone_verified)) return json({ ok: false, error: 'Telefon tasdiqlanmagan' }, 403);
  if (Number(user.banned)) return json({ ok: false, error: 'Hisob bloklangan' }, 403);
  if ((await getSetting(env, 'bot_enabled', '1')) !== '1') return json({ ok: false, error: 'Bot o‘chirilgan' }, 423);
  if ((await getSetting(env, 'clicker_enabled', '1')) !== '1') return json({ ok: false, error: 'Clicker o‘chirilgan' }, 423);
  const channels = await checkRequiredChannels(env, tgId);
  if (!channels.ok) return json({ ok: false, error: 'Majburiy kanallarga obuna bo‘ling' }, 403);

  let count = Number(body.count || 1);
  if (!Number.isInteger(count) || count < 1) count = 1;
  if (count > 20) count = 20;
  if (!(await allowClicks(env, tgId, count))) return json({ ok: false, error: 'Juda tez bosilyapti' }, 429);

  const target = Math.max(1, Number(await getSetting(env, 'click_target', '1000')));
  const reward = Math.max(0, Number(await getSetting(env, 'click_reward', '1')));
  const before = Number(user.total_clicks || 0);
  const after = before + count;
  const rewardUnits = Math.floor(after / target) - Math.floor(before / target);
  const earned = rewardUnits * reward;
  await db(env).execute({
    sql: `UPDATE users SET total_clicks=total_clicks+?, balance=balance+?, total_earned=total_earned+?, updated_at=? WHERE tg_id=?`,
    args: [count, earned, earned, now(), tgId],
  });
  const updated = await getUser(env, tgId);
  return json({ ok: true, earned, user: publicUser(updated), progress: Number(updated.total_clicks) % target });
}

async function allowClicks(env, tgId, count) {
  const t = now();
  const c = db(env);
  const r = await c.execute({ sql: 'SELECT * FROM click_rate WHERE tg_id=?', args: [tgId] });
  const row = r.rows[0];
  if (!row || t - Number(row.window_start) >= 1) {
    await c.execute({
      sql: `INSERT INTO click_rate(tg_id,window_start,count) VALUES(?,?,?)
            ON CONFLICT(tg_id) DO UPDATE SET window_start=excluded.window_start,count=excluded.count`,
      args: [tgId, t, count],
    });
    return count <= 25;
  }
  const next = Number(row.count) + count;
  if (next > 25) return false;
  await c.execute({ sql: 'UPDATE click_rate SET count=? WHERE tg_id=?', args: [next, tgId] });
  return true;
}

async function apiTaskVerify(request, env) {
  const body = await request.json();
  const auth = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  const tgId = String(auth.user.id);
  const task = await getTask(env, Number(body.task_id));
  if (!task || !Number(task.enabled)) return json({ ok: false, error: 'Vazifa topilmadi' }, 404);
  const user = await getUser(env, tgId);
  if (!user || !Number(user.phone_verified)) return json({ ok: false, error: 'Telefon tasdiqlanmagan' }, 403);
  if (Number(user.banned)) return json({ ok: false, error: 'Hisob bloklangan' }, 403);

  const done = await db(env).execute({ sql: 'SELECT 1 FROM completed_tasks WHERE task_id=? AND tg_id=?', args: [task.id, tgId] });
  if (done.rows.length) return json({ ok: true, completed: true, already: true, user: publicUser(user) });

  if (task.approval_mode === 'manual') {
    return json({
      ok: true,
      manual: true,
      deep_link: `https://t.me/${BOT_USERNAME}?start=task_${task.id}`,
      message: 'Botga o‘tib screenshot yuboring',
    });
  }

  if (task.type === 'channel' || task.type === 'group') {
    const r = await tg(env, 'getChatMember', { chat_id: task.check_chat, user_id: Number(tgId) });
    const st = r.result?.status;
    const joined = r.ok && (['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && r.result?.is_member));
    if (!joined) return json({ ok: false, error: 'Vazifa hali bajarilmagan' }, 400);
    await completeTask(env, task, tgId);
    const updated = await getUser(env, tgId);
    return json({ ok: true, completed: true, reward: Number(task.reward), user: publicUser(updated) });
  }

  if (task.type === 'bot') {
    return json({ ok: false, error: 'Hamkor bot hali tasdiq yubormadi' }, 400);
  }

  return json({ ok: false, error: 'Tekshirish turi qo‘llab-quvvatlanmaydi' }, 400);
}

async function partnerComplete(request, env) {
  const body = await request.json();
  const task = await getTask(env, Number(body.task_id));
  if (!task || task.type !== 'bot' || task.approval_mode !== 'auto') return json({ ok: false, error: 'Task topilmadi' }, 404);
  if (!task.partner_secret || body.secret !== task.partner_secret) return json({ ok: false, error: 'Forbidden' }, 403);
  const tgId = String(body.user_id || '');
  const user = await getUser(env, tgId);
  if (!user) return json({ ok: false, error: 'User topilmadi' }, 404);
  const awarded = await completeTask(env, task, tgId);
  if (awarded) await send(env, tgId, `✅ Hamkor bot vazifasi tasdiqlandi. +${task.reward} ⭐`);
  return json({ ok: true, awarded });
}

function publicUser(u) {
  return {
    tg_id: String(u.tg_id),
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || '',
    balance: Number(u.balance || 0),
    total_earned: Number(u.total_earned || 0),
    total_clicks: Number(u.total_clicks || 0),
    referrals_count: Number(u.referrals_count || 0),
  };
}

async function validateInitData(initData, botToken) {
  try {
    if (!initData) return { ok: false, error: 'Telegram initData yo‘q' };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'hash yo‘q' };
    params.delete('hash');
    const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

    const enc = new TextEncoder();
    const key1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretBytes = await crypto.subtle.sign('HMAC', key1, enc.encode(botToken));
    const key2 = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key2, enc.encode(dataCheckString));
    const calc = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!timingSafeEqual(calc, hash)) return { ok: false, error: 'initData imzosi noto‘g‘ri' };

    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.abs(now() - authDate) > 24 * 60 * 60) return { ok: false, error: 'initData eskirgan' };
    const rawUser = params.get('user');
    if (!rawUser) return { ok: false, error: 'user yo‘q' };
    const user = JSON.parse(rawUser);
    return { ok: true, user };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', WEB_APP_URL);
  h.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
