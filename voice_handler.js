'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// VOICE HANDLER
//
// Provides two capabilities:
//   1. transcribeVoiceNote() – WhatsApp OGG Opus → text  (OpenAI Whisper API)
//   2. textToVoiceNote()     – text → WhatsApp OGG Opus  (OpenAI TTS API)
//
// TTS upgrade: OpenAI TTS (tts-1) replaces the old gTTS + ffmpeg pipeline.
//   • Much more natural, human-sounding voice
//   • Native multilingual support — no separate Hindi/English detection needed
//   • Returns Opus format directly — compatible with WhatsApp voice notes
//   • Cost: ~$0.015 per 1,000 chars  (≈ $1–3 for the entire wedding)
//
// STT cost (unchanged):
//   • Whisper API: ~$0.006/min × avg 20s ≈ $0.002 per note → ≈ $0.20 total
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// 1. SPEECH-TO-TEXT  (Whisper API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes a WhatsApp voice note to text via OpenAI Whisper.
 *
 * @param {import('openai').default} openaiClient  The shared OpenAI instance.
 * @param {string}  base64Data                     Base64-encoded OGG audio.
 * @returns {Promise<string>}                      Transcribed text (trimmed).
 */
async function transcribeVoiceNote(openaiClient, base64Data) {
  const tmpIn = path.join(
    os.tmpdir(),
    `wb_in_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`
  );

  try {
    fs.writeFileSync(tmpIn, Buffer.from(base64Data, 'base64'));

    const result = await openaiClient.audio.transcriptions.create({
      file:  fs.createReadStream(tmpIn),
      model: 'whisper-1',
      // Context hint: helps Whisper correctly recognise wedding-specific terms
      // and names in Hindi / English / Hinglish
      prompt: [
        'Wedding of Surakshit and Shreyaa in Jaipur.',
        'Venues: InterContinental Jaipur, Atlantis Jaipur, Atlantis, Convergence Ballroom.',
        'Events: Welcome Lunch, Mayera, Reetein, Sangeet, Chooda Ceremony, Gidda & Gossip, Sehra Bandi, Baraat Assembly, Baraat Welcome, Varmala, Reception, Pheras, Breakfast.',
        'Hashtag: ShreyaaHuiSurakshit.',
        'Guests may speak in Hindi, English, or Hinglish.',
      ].join(' '),
    });

    return (result.text || '').trim();

  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) { }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TEXT-TO-SPEECH  (OpenAI TTS API → OGG Opus)
//
// OpenAI tts-1 with response_format:'opus' returns an OGG Opus file directly —
// the exact format WhatsApp expects for voice notes. No ffmpeg conversion needed.
//
// Voice selection:
//   We use 'nova' — warm, clear, and natural. Other options: alloy, echo,
//   fable, onyx, shimmer. All voices handle English and Hindi.
// ─────────────────────────────────────────────────────────────────────────────

const TTS_VOICE = process.env.TTS_VOICE || 'nova';

/**
 * Converts the bot's text reply into a WhatsApp-compatible OGG Opus voice note
 * using the OpenAI TTS API.
 *
 * @param {import('openai').default} openaiClient  The shared OpenAI instance.
 * @param {string} text                            Bot reply text to speak aloud.
 * @returns {Promise<string>}                      Absolute path to the .ogg file.
 */
async function textToVoiceNote(openaiClient, text) {
  const oggPath = path.join(
    os.tmpdir(),
    `wb_out_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`
  );

  // ── Sanitise text for TTS ─────────────────────────────────────────────────
  // Remove WhatsApp formatting markers and visual-only characters so the TTS
  // reads clean prose instead of saying "asterisk Sangeet asterisk".
  const spoken = text
    .replace(/\*([^*]+)\*/g, '$1')                               // *bold* → bold
    .replace(/━+/g, ' ')                                         // ━━━━━━ → space
    .replace(/•/g, ',')                                          // bullet → comma pause
    .replace(/[^\x20-\x7E\u0900-\u097F\n.,!?।]/g, '')           // strip emojis
    .replace(/\n+/g, ' ')                                        // newlines → space
    .replace(/[ \t]{2,}/g, ' ')                                  // collapse spaces
    .trim();

  // OpenAI TTS has a 4096-char input limit; truncate gracefully if needed
  const input = spoken.length > 4000 ? spoken.slice(0, 4000) + '.' : spoken;

  const response = await openaiClient.audio.speech.create({
    model:           'tts-1',
    voice:           TTS_VOICE,
    input,
    response_format: 'opus',   // OGG Opus — directly compatible with WhatsApp
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(oggPath, buffer);

  return oggPath;
}

module.exports = { transcribeVoiceNote, textToVoiceNote };
