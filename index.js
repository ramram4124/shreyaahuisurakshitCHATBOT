'use strict';

require('dotenv').config();

const fs   = require('fs');
const http = require('http');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode  = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { execSync } = require('child_process');
const path    = require('path');
const OpenAI  = require('openai');
const { buildSystemPrompt } = require('./knowledge_base');
const { transcribeVoiceNote, textToVoiceNote } = require('./voice_handler');
const { searchWeb } = require('./web_search');
const store   = require('./store');

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
  console.error('\n❌  ERROR: OPENAI_API_KEY is not set in your .env file.');
  console.error('   Open .env and replace "your_openai_api_key_here" with your real key.\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI CLIENT & CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const openai        = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// System prompt is generated dynamically per request to ensure correct current date/time
const MODEL         = 'gpt-4o-mini';

const FALLBACK_MSG =
  '🙏 So sorry, I ran into a small hiccup! Please try again in a moment, or contact the family directly for urgent queries. 😊';

// Only reply to messages received AFTER the bot is ready (ignores backlog)
let botReadyAt = null;

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CONFIG
//
// Set ADMIN_NUMBER in .env as your WhatsApp number in international format,
// no '+' or spaces.  Example: ADMIN_NUMBER=919876543210
// The bot appends '@c.us' automatically.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_RAW    = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const ADMIN_JID    = ADMIN_RAW ? `${ADMIN_RAW}@c.us` : null;

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER
//
// Prevents a single guest from spamming the bot (and racking up API costs).
// Allows up to RATE_LIMIT messages per RATE_WINDOW_MS per phone number.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT     = 15;          // max messages per window
const RATE_WINDOW_MS = 60_000;      // 1 minute
const _rateBuckets   = new Map();   // userId → { count, windowStart }

function isRateLimited(userId) {
  const now   = Date.now();
  const entry = _rateBuckets.get(userId) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    // Start a fresh window
    _rateBuckets.set(userId, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  _rateBuckets.set(userId, entry);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP FORMATTING SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cleans up GPT output to ensure it renders correctly on WhatsApp.
 * Despite system-prompt instructions, gpt-4o-mini occasionally slips into
 * Markdown on long responses. This is a server-side safety net.
 */
function sanitizeForWhatsApp(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')  // **bold** → *bold*
    .replace(/^#{1,6}\s+/gm, '')             // ## Heading → Heading
    .replace(/^-{3,}$/gm, '━━━━━━')          // --- → ━━━━━━
    .replace(/^_{3,}$/gm, '━━━━━━')          // ___ → ━━━━━━
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI TOOL DEFINITION  (web_search)
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search Google for real-time information NOT available in the wedding knowledge base. ' +
        'Use this for: ' +
        '(1) Hotel/venue phone numbers, Google Maps links, exact addresses. ' +
        '(2) Distances or travel times between locations, directions. ' +
        '(3) LOCAL SERVICES near the venues — makeup artists, bridal makeup, hair stylists, ' +
        'beauty salons, nail salons, laundry/dry cleaning services, tailors/alterations, ' +
        'pharmacies/chemists, ATMs, restaurants, cafes, florists, gift shops. ' +
        '(4) Weather in Jaipur. ' +
        '(5) Any other live factual detail the knowledge base cannot answer. ' +
        'Do NOT call this for info already in the knowledge base (itinerary, dress codes, food at the hotel, shuttle etc.). ' +
        'IMPORTANT: for any "near me" or "nearby" query, ALWAYS anchor to the actual area — ' +
        'both venues are in Sitapura RIICO Industrial Area, Tonk Road, Jaipur 302022. ' +
        'Use "Sitapura Tonk Road Jaipur 302022" in the query, NOT just the hotel name, ' +
        'to get geographically accurate results (using only the hotel name can return results from wrong parts of Jaipur).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Precise, area-anchored search query. Both venues are in Sitapura RIICO Industrial Area, Tonk Road, Jaipur 302022. ' +
              'Examples: ' +
              '"InterContinental Jaipur Tonk Road phone number", ' +
              '"InterContinental Jaipur Tonk Road Google Maps link", ' +
              '"Jaipur airport to Sitapura Tonk Road Jaipur distance", ' +
              '"bridal makeup artists Sitapura Tonk Road Jaipur 302022", ' +
              '"hair salons Sitapura Tonk Road Jaipur 302022", ' +
              '"laundry dry cleaning Sitapura Tonk Road Jaipur 302022", ' +
              '"pharmacy chemist Sitapura Tonk Road Jaipur 302022", ' +
              '"restaurants Sitapura Tonk Road Jaipur 302022"',
          },
        },
        required: ['query'],
      },
    },
  },
];

const SEARCH_ENABLED =
  !!process.env.SERPER_API_KEY &&
  process.env.SERPER_API_KEY !== 'your_serper_key_here';

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI QUERY  (with function-calling loop)
// ─────────────────────────────────────────────────────────────────────────────

async function askOpenAI(userId, userMessage) {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...store.getHistory(userId),
    { role: 'user', content: userMessage },
  ];

  let response = await openai.chat.completions.create({
    model: MODEL,
    messages,
    tools:       SEARCH_ENABLED ? TOOLS     : undefined,
    tool_choice: SEARCH_ENABLED ? 'auto'    : undefined,
    temperature: 0.5,
    max_tokens:  700,
  });

  let assistantMsg = response.choices[0].message;

  // ── Tool-call loop ────────────────────────────────────────────────────────
  while (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
    messages.push(assistantMsg);

    for (const call of assistantMsg.tool_calls) {
      if (call.function.name === 'web_search') {
        const { query } = JSON.parse(call.function.arguments);
        console.log(`🔍  [${userId}] Searching: "${query}"`);

        let result;
        try {
          result = await searchWeb(query);
          console.log(`✅  [${userId}] Search returned ${result.length} chars`);
        } catch (err) {
          result = `Search unavailable: ${err.message}`;
          console.warn(`⚠️   [${userId}] Search failed: ${err.message}`);
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    response     = await openai.chat.completions.create({ model: MODEL, messages, temperature: 0.5, max_tokens: 700 });
    assistantMsg = response.choices[0].message;
  }

  const reply = sanitizeForWhatsApp((assistantMsg.content || '').trim());
  store.appendToHistory(userId, 'user', userMessage);
  store.appendToHistory(userId, 'assistant', reply);
  return reply;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function safeReply(message, text) {
  try { await message.reply(text); } catch (_) { }
}

async function safeReact(message, emoji) {
  try { await message.react(emoji); } catch (_) { }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN COMMAND HANDLER
//
// Only the phone number set in ADMIN_NUMBER can trigger these commands.
// Commands (send as a WhatsApp text message to the bot number):
//
//   /stats
//       Returns total users, total messages, and the top 5 most active guests.
//
//   /broadcast <your message here>
//       Sends your message to every guest who has ever messaged the bot.
//       Use this for real-time updates: "Pheras starting now at Atlantiis! 🎊"
//
//   /reset <phone>
//       Clears the conversation history for a specific guest phone number.
//       Phone format: country code + number, e.g. 919876543210
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdminCommand(message, text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const spaceIdx  = trimmed.indexOf(' ');
  const cmd       = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args      = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // ── /stats ────────────────────────────────────────────────────────────────
  if (cmd === 'stats') {
    const s = store.getStats();
    const top = s.topUsers.length > 0
      ? s.topUsers.map((u, i) => `  ${i + 1}. ${u}`).join('\n')
      : '  (no messages yet)';

    await safeReply(
      message,
      `📊 *SuSh Bot Stats*\n\n` +
      `👥 Unique guests: *${s.totalUsers}*\n` +
      `💬 Total messages: *${s.totalMessages}*\n\n` +
      `*Top 5 active guests:*\n${top}`
    );
    return true;
  }

  // ── /broadcast ────────────────────────────────────────────────────────────
  if (cmd === 'broadcast') {
    if (!args) {
      await safeReply(message, '⚠️ Usage: /broadcast <your message>');
      return true;
    }

    const allUsers = store.getAllUserIds();
    // Exclude admin's own number from broadcast
    const targets  = allUsers.filter(uid => uid !== ADMIN_JID);

    if (targets.length === 0) {
      await safeReply(message, '📢 No guests to broadcast to yet.');
      return true;
    }

    await safeReply(
      message,
      `📢 Broadcasting to *${targets.length}* guest(s)…\n\nMessage:\n${args}`
    );

    let sent = 0;
    let failed = 0;
    for (const userId of targets) {
      try {
        const chat = await client.getChatById(userId);
        await chat.sendMessage(args);
        sent++;
        // Brief pause between messages to avoid WhatsApp rate-limiting the sender
        await new Promise(r => setTimeout(r, 800));
      } catch (_) {
        failed++;
      }
    }

    await safeReply(
      message,
      `✅ Broadcast complete.\n✔️ Sent: ${sent}  ❌ Failed: ${failed}`
    );
    return true;
  }

  // ── /reset ────────────────────────────────────────────────────────────────
  if (cmd === 'reset') {
    if (!args) {
      await safeReply(message, '⚠️ Usage: /reset <phone>  (e.g. /reset 919876543210)');
      return true;
    }
    const phone  = args.replace(/\D/g, '');
    const target = `${phone}@c.us`;
    store.resetHistory(target);
    await safeReply(message, `🔄 Conversation history cleared for *${phone}*.`);
    return true;
  }

  // ── Unknown admin command ─────────────────────────────────────────────────
  await safeReply(
    message,
    `🤖 *Admin commands:*\n\n` +
    `• /stats\n` +
    `• /broadcast <message>\n` +
    `• /reset <phone>`
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleText(message, userId, text) {
  console.log(`📩  [${userId}] (text) "${text}"`);
  try {
    await safeReact(message, '⏳');
    const chat = await message.getChat();
    await chat.sendStateTyping();

    const reply = await askOpenAI(userId, text);
    await message.reply(reply);
    await safeReact(message, '✅');
    console.log(`📤  [${userId}] Text reply sent.`);
  } catch (err) {
    console.error(`❌  [${userId}] Text handler error:`, err.message);
    await safeReact(message, '❌');
    await safeReply(message, FALLBACK_MSG);
  }
}

async function handleVoiceNote(message, userId) {
  console.log(`🎙️  [${userId}] Voice note received – processing...`);
  let oggPath = null;

  try {
    await safeReact(message, '⏳');
    const chat = await message.getChat();
    await chat.sendStateTyping();

    // 1. Download
    const media = await message.downloadMedia();
    if (!media?.data) {
      await safeReply(message, "Hmm, I couldn't download your voice note 🙈 Please try again!");
      return;
    }

    // 2. Transcribe (Whisper)
    const transcribed = await transcribeVoiceNote(openai, media.data);
    console.log(`🗣️  [${userId}] Transcribed: "${transcribed}"`);

    if (!transcribed || transcribed.trim().length < 2) {
      await safeReply(
        message,
        "I couldn't make that out clearly 🙈\n\nCould you try again, or type your question instead?"
      );
      return;
    }

    // 3. GPT reply
    const reply = await askOpenAI(userId, transcribed);
    console.log(`🤖  [${userId}] GPT replied. Converting to voice...`);

    // 4. Text → OGG Opus voice note (OpenAI TTS)
    oggPath = await textToVoiceNote(openai, reply);

    // 5. Send voice note back
    const voiceMedia = new MessageMedia(
      'audio/ogg; codecs=opus',
      fs.readFileSync(oggPath).toString('base64'),
      'reply.ogg'
    );
    await message.reply(voiceMedia, null, { sendAudioAsVoice: true });
    await safeReact(message, '✅');
    console.log(`📤  [${userId}] Voice reply sent.`);

  } catch (err) {
    console.error(`❌  [${userId}] Voice handler error:`, err.message);
    await safeReact(message, '❌');
    await safeReply(message, FALLBACK_MSG);
  } finally {
    if (oggPath) try { if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath); } catch (_) { }
  }
}

async function handleUnsupportedMedia(message, msgType) {
  const labels = {
    image:    'image 📸',
    video:    'video 🎥',
    document: 'document 📄',
    sticker:  'sticker 😄',
  };
  const label = labels[msgType] || 'file 📎';

  await safeReply(
    message,
    `I can see you sent a ${label}!\n\n` +
    `I can only read *text messages* and listen to *voice notes* for now.\n\n` +
    `Try typing your question, or record a voice note and I'll respond with one! 🎙️`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP CLIENT
// ─────────────────────────────────────────────────────────────────────────────

// On Railway, CHROME_PATH can point to the system Chromium installed via nixpacks
// (set this in Railway's environment variables dashboard if needed).
const puppeteerArgs = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',   // prevents crashes in low-memory environments
    '--disable-gpu',             // not needed in headless server environments
  ],
};
if (process.env.CHROME_PATH) {
  puppeteerArgs.executablePath = process.env.CHROME_PATH;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth' }),
  puppeteer: puppeteerArgs,
});

// ── QR Code ───────────────────────────────────────────────────────────────────
const QR_FILE = path.join(__dirname, 'qr-auth.png');

client.on('qr', async (qr) => {
  console.log('\n📱  Generating QR code for WhatsApp authentication...');
  
  // 1. Print to Terminal (for Railway logs)
  qrcodeTerminal.generate(qr, { small: true });

  // 2. Save to File (for local debugging)
  try {
    await QRCode.toFile(QR_FILE, qr, {
      width: 280, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    console.log(`✅  QR saved to ${QR_FILE}\n`);
    
    // Auto-open only makes sense when running locally (Mac)
    if (!process.env.RAILWAY_ENVIRONMENT) {
      const openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
          : 'xdg-open';
      execSync(`${openCmd} "${QR_FILE}"`, { stdio: 'ignore' });
      console.log('   ✅ QR code opened in your default image viewer.');
    } else {
      console.log('   ⚠️  Running on Railway — QR code saved to:', QR_FILE);
      console.log('   Use "railway volume cp" to retrieve it, or pre-upload the session.');
    }
    console.log('   (Open WhatsApp → Linked Devices → Link a Device)\n');
  } catch (err) {
    console.error('   Could not generate QR. Error:', err.message);
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.on('ready', () => {
  botReadyAt = Date.now();
  const userCount = store.getUserCount();
  console.log('\n✅  WhatsApp bot is live and ready!');
  console.log(`🤖  Model        : ${MODEL}`);
  console.log(`🎙️  Voice notes  : Whisper STT → GPT → OpenAI TTS`);
  console.log(`👥  Known guests : ${userCount}`);
  console.log(`🔒  Admin        : ${ADMIN_JID || 'not configured (set ADMIN_NUMBER in .env)'}`);
  console.log(`🔍  Web search   : ${SEARCH_ENABLED ? 'enabled (Serper)' : 'disabled'}`);
  console.log('💬  Waiting for messages...\n');
});

client.on('auth_failure', (msg) => console.error('❌  Authentication failed:', msg));
client.on('disconnected',  (reason) => console.warn('⚠️   Bot disconnected:', reason));

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────────────────

client.on('message', async (message) => {
  if (message.isGroupMsg)               return;
  if (message.from === 'status@broadcast') return;
  if (!botReadyAt)                      return;

  const msgTimeMs = (message.timestamp || 0) * 1000;
  if (msgTimeMs < botReadyAt)           return;

  const userId  = message.from;
  const msgType = message.type;

  // ── Register / update user ────────────────────────────────────────────────
  let contactName = '';
  try {
    const contact = await message.getContact();
    contactName   = contact.pushname || contact.name || '';
  } catch (_) { }
  store.touchUser(userId, contactName);

  // ── Admin commands (only for configured admin number) ─────────────────────
  if (ADMIN_JID && userId === ADMIN_JID && msgType === 'chat') {
    const text = (message.body || '').trim();
    if (text.startsWith('/')) {
      const handled = await handleAdminCommand(message, text);
      if (handled) return;
    }
  }

  // ── Rate limit check ──────────────────────────────────────────────────────
  if (isRateLimited(userId)) {
    console.warn(`🚫  [${userId}] Rate limited`);
    await safeReply(
      message,
      "You're sending messages very quickly! 😅 Please wait a moment before trying again. 🙏"
    );
    return;
  }

  // ── Route by message type ─────────────────────────────────────────────────
  if (['image', 'video', 'document', 'sticker'].includes(msgType)) {
    await handleUnsupportedMedia(message, msgType);
    return;
  }

  if (msgType === 'ptt' || msgType === 'audio') {
    await handleVoiceNote(message, userId);
    return;
  }

  if (msgType === 'chat') {
    const text = (message.body || '').trim();
    if (!text) return;
    await handleText(message, userId, text);
    return;
  }

  // Any other type (location, contact card, etc.) — silently skip
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HEALTH CHECK SERVER
//
// Railway requires the process to bind to a port so it can:
//   (a) Detect that the service started successfully.
//   (b) Send health-check requests (healthcheckPath = "/health" in railway.toml).
//
// Without this, Railway marks the deployment as crashed even if the WhatsApp
// bot is running perfectly.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const isReady = botReadyAt !== null;
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:     isReady ? 'ready' : 'initialising',
      uptime:     isReady ? Math.round((Date.now() - botReadyAt) / 1000) + 's' : null,
      users:      store.getUserCount(),
      messages:   store.getStats().totalMessages,
      model:      MODEL,
      search:     SEARCH_ENABLED,
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SuSh Wedding Bot 💍');
  }
});

httpServer.listen(PORT, () => {
  console.log(`🌐  Health server listening on port ${PORT}  →  GET /health`);
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-MIGRATION (Local -> Volume)
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';

function migrateSessionToVolume() {
  const localPath = path.join(__dirname, '.wwebjs_auth');
  
  // If we are on Railway and have a volume mount, but it's empty, and we have a local session...
  if (process.env.RAILWAY_ENVIRONMENT && AUTH_PATH.startsWith('/data') && fs.existsSync(localPath)) {
    if (!fs.existsSync(AUTH_PATH)) {
      console.log('🚚  First-time setup: Migrating local session to persistent volume...');
      try {
        // Simple recursive copy (native node)
        fs.cpSync(localPath, AUTH_PATH, { recursive: true });
        console.log('✅  Session migrated to volume.');
      } catch (err) {
        console.error('❌  Migration failed:', err.message);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🎊  Surakshit & Shreyaa Wedding Bot');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('   Initialising WhatsApp client...\n');

migrateSessionToVolume();
client.initialize();
