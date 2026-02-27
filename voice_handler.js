'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// VOICE HANDLER
//
// Provides two capabilities:
//   1. transcribeVoiceNote() – WhatsApp OGG Opus → text  (OpenAI Whisper API)
//   2. textToVoiceNote()     – text → WhatsApp OGG Opus  (node-gtts + ffmpeg)
//
// Cost breakdown for the entire wedding (~100 voice notes):
//   • Whisper API  : ~$0.006/min × avg 20s = ~$0.002 per note → ≈$0.20 total
//   • node-gtts    : $0.00  (uses Google Translate TTS endpoint, no key needed)
//   • ffmpeg       : $0.00  (bundled binary via ffmpeg-static)
// ─────────────────────────────────────────────────────────────────────────────

const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const gtts       = require('node-gtts');

// Point fluent-ffmpeg at the bundled binary — no system ffmpeg install needed
ffmpeg.setFfmpegPath(ffmpegPath);

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects whether a text string is primarily Hindi (Devanagari) or Roman
 * (English / Hinglish) so we can pick the right gTTS voice.
 *
 * Strategy: if >15% of non-whitespace characters are Devanagari Unicode
 * (U+0900–U+097F), treat the text as Hindi. Everything else (English,
 * Hinglish written in Roman script) falls back to English TTS.
 *
 * @param {string} text
 * @returns {'hi'|'en'}
 */
function detectLang(text) {
  const nonSpace     = text.replace(/\s/g, '');
  if (!nonSpace.length) return 'en';
  const devanagari   = (text.match(/[\u0900-\u097F]/g) || []).length;
  return (devanagari / nonSpace.length) > 0.15 ? 'hi' : 'en';
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SPEECH-TO-TEXT  (Whisper API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes a WhatsApp voice note to text via OpenAI Whisper.
 *
 * WhatsApp delivers voice notes as base64-encoded OGG Opus audio.
 * Whisper auto-detects the language, so Hindi, English, and Hinglish all work.
 *
 * @param {import('openai').default} openaiClient  The shared OpenAI instance.
 * @param {string}  base64Data                     Base64 string of the audio.
 * @returns {Promise<string>}                      Transcribed text (trimmed).
 */
async function transcribeVoiceNote(openaiClient, base64Data) {
  const tmpIn = path.join(os.tmpdir(), `wb_in_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);

  try {
    // Write base64 audio to a temp OGG file so Whisper can stream it
    fs.writeFileSync(tmpIn, Buffer.from(base64Data, 'base64'));

    const result = await openaiClient.audio.transcriptions.create({
      file:  fs.createReadStream(tmpIn),
      model: 'whisper-1',
      // No `language` param → Whisper auto-detects Hindi / English / Hinglish.
      // The `prompt` primes Whisper with wedding vocabulary so it transcribes
      // names, ceremony terms, and venue names accurately.
      prompt: [
        'Wedding of Surakshit and Shreyaa in Jaipur.',
        'Venues: InterContinental Jaipur, Atlantiis Jaipur, Convergence Ballroom.',
        'Events: Sangeet, Haldi, Mayera, Reets, Choora, Sehrabandi, Baraat, Milni, Varmala, Pheras.',
        'Hashtag: ShreyaaHuiSurakshit.',
        'Guests may speak in Hindi, English, or Hinglish.',
      ].join(' '),
    });

    return (result.text || '').trim();

  } finally {
    // Always clean up the temp file, even if transcription throws
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TEXT-TO-SPEECH  (node-gtts → ffmpeg → OGG Opus)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts the bot's text reply into a WhatsApp-compatible voice note.
 *
 * Pipeline:
 *   bot reply text
 *     → detectLang()  (Devanagari → 'hi', Roman → 'en')
 *     → sanitise      (strip emojis, *bold* markers, ━━━ lines)
 *     → node-gtts     (Google Translate TTS, correct language voice)  →  temp MP3
 *     → ffmpeg        (libopus)  →  temp OGG Opus
 *
 * Supports:
 *   • English responses  → English TTS voice
 *   • Hindi responses (Devanagari)  → Hindi TTS voice
 *   • Hinglish (Roman Hindi)  → English TTS voice (reads Roman script naturally)
 *
 * @param {string} text   The bot's reply text.
 * @returns {Promise<string>}  Absolute path to the .ogg file.
 *                             ⚠️  CALLER must delete this file after sending.
 */
function textToVoiceNote(text) {
  return new Promise((resolve, reject) => {

    const uid     = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const mp3Path = path.join(os.tmpdir(), `wb_out_${uid}.mp3`);
    const oggPath = path.join(os.tmpdir(), `wb_out_${uid}.ogg`);

    // ── Detect language BEFORE stripping Devanagari ───────────────────────────
    // (sanitisation removes Devanagari if we don't check first)
    const lang = detectLang(text);

    // ── Sanitise text for TTS ─────────────────────────────────────────────────
    // Keeps: printable ASCII, Devanagari, basic punctuation, newlines.
    // Strips: emojis, WhatsApp bold markers (*), box-drawing chars (━ •).
    const spoken = text
      .replace(/\*([^*]+)\*/g,  '$1')    // *bold*  →  bold  (strip WA markers)
      .replace(/━+/g,           ' ')     // ━━━━━━  →  space
      .replace(/•/g,            ',')     // bullet  →  natural comma pause
      .replace(/[^\x20-\x7E\u0900-\u097F\n.,!?।]/g, '')  // strip emojis; keep Devanagari + danda (।)
      .replace(/\n{2,}/g,       '. ')    // paragraph break  →  full stop + pause
      .replace(/\n/g,           ', ')    // single newline   →  short comma pause
      .replace(/[ \t]{2,}/g,    ' ')     // collapse extra spaces
      .trim();

    // ── Step 1: text → MP3 via Google TTS (free, no API key) ─────────────────
    // Language is auto-detected: 'hi' for Devanagari, 'en' for everything else.
    const tts = gtts(lang);
    tts.save(mp3Path, spoken, (err) => {
      if (err) {
        return reject(new Error(`gTTS failed: ${err.message || err}`));
      }

      // ── Step 2: MP3 → OGG Opus (WhatsApp native voice-note format) ───────────
      ffmpeg(mp3Path)
        .audioCodec('libopus')
        .audioBitrate('32k')       // 32 kbps is fine for speech
        .audioChannels(1)          // mono
        .audioFrequency(48000)     // Opus standard sample rate
        .toFormat('ogg')
        .save(oggPath)
        .on('end', () => {
          try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (_) {}
          resolve(oggPath);
        })
        .on('error', (e) => {
          try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (_) {}
          reject(new Error(`ffmpeg conversion failed: ${e.message}`));
        });
    });
  });
}

module.exports = { transcribeVoiceNote, textToVoiceNote };
