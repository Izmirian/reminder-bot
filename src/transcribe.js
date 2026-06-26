/**
 * Voice-note transcription via OpenAI Whisper. Shared by both platforms.
 * Returns the transcript string, or null if OPENAI_API_KEY is unset or the
 * request fails (callers surface a friendly "voice not configured" message).
 */
export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `voice.${ext}`);
    formData.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text || null;
  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    return null;
  }
}

export function isTranscriptionConfigured() {
  return !!process.env.OPENAI_API_KEY;
}
