'use strict';

// ---------------------------------------------------------------------------
// transcribe.js — turning a forwarded voice note into text.
//
// An honest note about why this file exists at all, rather than the audio going
// straight to the extractor: the Claude API takes text and images, not audio.
// So a voice note needs a speech-to-text step first, and that step needs a
// provider.
//
// Two are supported, and which one you get depends only on configuration:
//
//   whisper-api  — an OpenAI-compatible /audio/transcriptions endpoint. Works
//                  with OpenAI itself or with any local server that copies its
//                  shape (whisper.cpp's server, faster-whisper, LocalAI). Set
//                  TRANSCRIBE_URL and, if the endpoint needs one, TRANSCRIBE_KEY.
//   none         — nothing configured. Voice notes are politely refused with an
//                  explanation, and nothing else in the app changes.
//
// Keeping the provider behind this one interface is what makes the Raspberry Pi
// plan work later: point TRANSCRIBE_URL at a whisper.cpp server on the same box
// and no other file changes.
// ---------------------------------------------------------------------------

const config = require('./config');
const { createLogger } = require('./log');

const log = createLogger('voice');

/** Is transcription available at all? The bot checks this before downloading. */
function isConfigured() {
  return Boolean(config.transcribe.url);
}

/**
 * Transcribe an audio buffer. Returns the text, or throws with a message
 * suitable for showing to the user.
 *
 * @param buffer   the raw audio bytes
 * @param filename Telegram sends OGG/Opus; the extension tells the server how
 *                 to decode, and some implementations rely on it.
 */
async function transcribe(buffer, filename = 'voice.ogg') {
  if (!isConfigured()) {
    throw new Error('voice transcription is not configured on this server');
  }

  // multipart/form-data, built with the platform's own FormData + Blob so there
  // is no dependency and no hand-rolled boundary string to get wrong.
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', config.transcribe.model);
  // Asking for plain text avoids having to care whether the server returns
  // {text: "..."} or a verbose JSON object with segments.
  form.append('response_format', 'text');

  const headers = {};
  // Local whisper servers usually need no key; hosted ones do.
  if (config.transcribe.key) headers.authorization = `Bearer ${config.transcribe.key}`;

  let res;
  try {
    res = await fetch(config.transcribe.url, {
      method: 'POST',
      headers,
      body: form,
      // Generous: a two-minute voice note on a small local model is slow.
      signal: AbortSignal.timeout(config.transcribe.timeoutMs),
    });
  } catch (err) {
    // Same unwrapping as telegram.js — fetch hides the real cause.
    throw new Error(`transcriber unreachable (${err.cause?.code || err.name})`);
  }

  const body = await res.text();
  if (!res.ok) {
    log.error(`transcriber ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`transcriber returned ${res.status}`);
  }

  // response_format=text gives bare text, but some servers ignore it and return
  // JSON anyway. Accept either rather than failing on a cosmetic difference.
  const text = body.trim().startsWith('{')
    ? (JSON.parse(body).text || '').trim()
    : body.trim();

  if (!text) throw new Error('nothing audible in that recording');
  return text;
}

module.exports = { isConfigured, transcribe };
