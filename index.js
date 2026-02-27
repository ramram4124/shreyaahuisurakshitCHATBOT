'use strict';

require('dotenv').config();

const fs                               = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode                           = require('qrcode');
const { execSync }                     = require('child_process');
const path                             = require('path');
const OpenAI                           = require('openai');
const { buildSystemPrompt }            = require('./knowledge_base');
const { transcribeVoiceNote, textToVoiceNote } = require('./voice_handler');
const { searchWeb }                    = require('./web_search');

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

const openai           = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SYSTEM_PROMPT    = buildSystemPrompt();
const MODEL            = 'gpt-4o-mini';
const MAX_HISTORY_PAIRS = 8; // last 8 user+assistant turns = 16 messages

const FALLBACK_MSG =
  '🙏 So sorry, I ran into a small hiccup! Please try again in a moment, or contact the family directly for urgent queries. 😊';

// Only reply to messages received AFTER the bot is ready (ignores backlog)
let botReadyAt = null;

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION MEMORY  (in-memory, per user, rolling window)
// ─────────────────────────────────────────────────────────────────────────────

const conversationStore = new Map(); // Map<phoneNumber, Message[]>

function getHistory(userId) {
  if (!conversationStore.has(userId)) conversationStore.set(userId, []);
  return conversationStore.get(userId);
}

function appendToHistory(userId, role, content) {
  const history    = getHistory(userId);
  const maxMsgs    = MAX_HISTORY_PAIRS * 2;
  history.push({ role, content });
  if (history.length > maxMsgs) history.splice(0, history.length - maxMsgs);
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP FORMATTING SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cleans up GPT output to ensure it renders correctly on WhatsApp.
 *
 * Problem: despite system-prompt instructions, gpt-4o-mini occasionally falls
 * back to Markdown conventions (**bold**, ## headers, ---) on long responses.
 * This is a server-side safety net that fixes every reply before sending.
 *
 * Rules enforced:
 *   **text**  →  *text*   (Markdown bold → WhatsApp bold)
 *   ## Header →  Header   (strip Markdown headers – they're invisible on WA)
 *   ---       →  ━━━━━    (replace hr with a WhatsApp-visible divider)
 */
function sanitizeForWhatsApp(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')   // **bold** → *bold*
    .replace(/^#{1,6}\s+/gm,       '')        // ## Heading → Heading
    .replace(/^-{3,}$/gm,          '━━━━━━') // --- → ━━━━━━
    .replace(/^_{3,}$/gm,          '━━━━━━') // ___ → ━━━━━━
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI TOOL DEFINITION  (web_search)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool made available to gpt-4o-mini via OpenAI function calling.
 * The model decides on its own whether to call it based on the description.
 *
 * When to search  : hotel/venue phone numbers, Google Maps links, distances,
 *                   travel time, directions, any live factual info NOT in KB.
 * When NOT to search : anything already answered by the wedding knowledge base.
 */
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

// Whether web search is enabled (requires SERPER_API_KEY in .env)
const SEARCH_ENABLED =
  !!process.env.SERPER_API_KEY &&
  process.env.SERPER_API_KEY !== 'your_serper_key_here';

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI QUERY  (with function-calling loop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a message to gpt-4o-mini with the full system prompt + rolling history.
 * If the model decides to call `web_search`, we execute it and feed the results
 * back so the model can compose a final answer — all in one user-facing reply.
 *
 * Works for both text queries and voice-note transcriptions (same memory).
 */
async function askOpenAI(userId, userMessage) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(userId),
    { role: 'user', content: userMessage },
  ];

  // First API call — include tools only when search is configured
  let response = await openai.chat.completions.create({
    model:       MODEL,
    messages,
    tools:       SEARCH_ENABLED ? TOOLS : undefined,
    tool_choice: SEARCH_ENABLED ? 'auto' : undefined,
    temperature: 0.5,
    max_tokens:  700,   // +100 headroom for responses that include search data
  });

  let assistantMsg = response.choices[0].message;

  // ── Tool-call loop (model may call web_search once or more) ─────────────────
  while (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
    messages.push(assistantMsg);  // add assistant's intent to the thread

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

        // Feed the result back as a tool message
        messages.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      result,
        });
      }
    }

    // Second API call — model now has search results and writes the final reply
    response     = await openai.chat.completions.create({
      model:       MODEL,
      messages,
      temperature: 0.5,
      max_tokens:  700,
    });
    assistantMsg = response.choices[0].message;
  }

  // Sanitize formatting before saving to history and sending
  const reply = sanitizeForWhatsApp((assistantMsg.content || '').trim());

  appendToHistory(userId, 'user',      userMessage);
  appendToHistory(userId, 'assistant', reply);
  return reply;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Fire-and-forget safe reply — never throws. */
async function safeReply(message, text) {
  try { await message.reply(text); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles a plain text message.
 * Shows a typing indicator → queries GPT → replies with text.
 */
async function handleText(message, userId, text) {
  console.log(`📩  [${userId}] (text) "${text}"`);
  try {
    const chat = await message.getChat();
    await chat.sendStateTyping();

    const reply = await askOpenAI(userId, text);
    await message.reply(reply);
    console.log(`📤  [${userId}] Text reply sent.`);
  } catch (err) {
    console.error(`❌  [${userId}] Text handler error:`, err.message);
    await safeReply(message, FALLBACK_MSG);
  }
}

/**
 * Handles a voice note (ptt) or audio file.
 *
 * Full pipeline:
 *   Download OGG  →  Whisper STT  →  GPT-4o-mini  →  gTTS + ffmpeg  →  OGG voice note reply
 */
async function handleVoiceNote(message, userId) {
  console.log(`🎙️  [${userId}] Voice note received – processing...`);
  let oggPath = null;

  try {
    // Show typing indicator while the pipeline runs
    const chat = await message.getChat();
    await chat.sendStateTyping();

    // ── 1. Download the voice note from WhatsApp ──────────────────────────────
    const media = await message.downloadMedia();
    if (!media?.data) {
      await safeReply(message, "Hmm, I couldn't download your voice note 🙈 Please try again!");
      return;
    }

    // ── 2. Transcribe (OpenAI Whisper – auto-detects Hindi / English / Hinglish) ──
    const transcribed = await transcribeVoiceNote(openai, media.data);
    console.log(`🗣️  [${userId}] Transcribed: "${transcribed}"`);

    if (!transcribed || transcribed.trim().length < 2) {
      await safeReply(
        message,
        "I couldn't make that out clearly 🙈\n\nCould you try again, or type your question instead?"
      );
      return;
    }

    // ── 3. Get GPT-4o-mini response (same conversation memory as text) ─────────
    const reply = await askOpenAI(userId, transcribed);
    console.log(`🤖  [${userId}] GPT replied. Converting to voice...`);

    // ── 4. Convert reply text → OGG Opus voice note ───────────────────────────
    oggPath = await textToVoiceNote(reply);

    // ── 5. Send back as a WhatsApp voice note (replies to the original message) ──
    const voiceMedia = new MessageMedia(
      'audio/ogg; codecs=opus',
      fs.readFileSync(oggPath).toString('base64'),
      'reply.ogg'
    );
    await message.reply(voiceMedia, null, { sendAudioAsVoice: true });
    console.log(`📤  [${userId}] Voice reply sent.`);

  } catch (err) {
    console.error(`❌  [${userId}] Voice handler error:`, err.message);
    await safeReply(message, FALLBACK_MSG);
  } finally {
    // Always clean up the temp OGG file
    if (oggPath) try { if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath); } catch (_) {}
  }
}

/**
 * Handles unsupported media types (images, video, documents, stickers).
 * Sends a friendly explanation without crashing.
 */
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

// Fresh session every run: clear cached auth so QR scan is required
const authPath = path.join(__dirname, '.wwebjs_auth');
const cachePath = path.join(__dirname, '.wwebjs_cache');
for (const dir of [authPath, cachePath]) {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`⚠️  Could not clear ${path.basename(dir)}. Stop any running bot first, then retry.`);
    }
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// ── QR Code ───────────────────────────────────────────────────────────────────
const QR_FILE = path.join(__dirname, 'qr-auth.png');

client.on('qr', async (qr) => {
  console.log('\n📱  Generating QR code for WhatsApp authentication...\n');
  try {
    await QRCode.toFile(QR_FILE, qr, {
      width: 280, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const openCmd = process.platform === 'darwin' ? 'open'
                  : process.platform === 'win32'  ? 'start'
                  :                                 'xdg-open';
    execSync(`${openCmd} "${QR_FILE}"`, { stdio: 'ignore' });
    console.log('   ✅ QR code opened in your default image viewer.');
    console.log('   (Open WhatsApp → Linked Devices → Link a Device)\n');
  } catch (err) {
    console.error('   Could not auto-open QR. Check the file manually:', QR_FILE);
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.on('ready', () => {
  botReadyAt = Date.now();
  console.log('\n✅  WhatsApp bot is live and ready!');
  console.log(`🤖  Model       : ${MODEL}`);
  console.log('🎙️  Voice notes : transcribe (Whisper) + respond (gTTS voice note)');
  console.log('📸  Images      : friendly decline message');
  console.log('💬  Waiting for messages...\n');
});

// ── Auth failure ──────────────────────────────────────────────────────────────
client.on('auth_failure', (msg) => {
  console.error('❌  Authentication failed:', msg);
});

// ── Disconnected ──────────────────────────────────────────────────────────────
client.on('disconnected', (reason) => {
  console.warn('⚠️   Bot disconnected:', reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// Routes incoming messages to the correct handler based on type.
//
//  'chat'                     → handleText
//  'ptt' (push-to-talk)       → handleVoiceNote
//  'audio'                    → handleVoiceNote
//  'image','video','document',
//  'sticker'                  → handleUnsupportedMedia (friendly decline)
//   everything else           → silently ignored
// ─────────────────────────────────────────────────────────────────────────────

client.on('message', async (message) => {
  // Skip group chats and WhatsApp status broadcasts
  if (message.isGroupMsg)                   return;
  if (message.from === 'status@broadcast')  return;

  // Ignore backlog: only reply to messages received AFTER the bot connected
  if (!botReadyAt) return;
  const msgTimeMs = (message.timestamp || 0) * 1000;
  if (msgTimeMs < botReadyAt) return;

  const userId  = message.from;   // e.g. "919876543210@c.us"
  const msgType = message.type;   // 'chat' | 'ptt' | 'audio' | 'image' | ...

  // ── Images, videos, documents, stickers → polite decline ─────────────────
  if (['image', 'video', 'document', 'sticker'].includes(msgType)) {
    await handleUnsupportedMedia(message, msgType);
    return;
  }

  // ── Voice notes & audio files → full voice pipeline ───────────────────────
  if (msgType === 'ptt' || msgType === 'audio') {
    await handleVoiceNote(message, userId);
    return;
  }

  // ── Plain text ─────────────────────────────────────────────────────────────
  if (msgType === 'chat') {
    const text = (message.body || '').trim();
    if (!text) return;
    await handleText(message, userId, text);
    return;
  }

  // Any other type (location, contact, etc.) — silently skip
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🎊  Surakshit & Shreyaa Wedding Bot');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('   Initialising WhatsApp client...\n');

client.initialize();
