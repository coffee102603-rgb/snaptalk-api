import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { create as createYoutubeDl } from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import os from 'os';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ytDlpPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
const youtubeDl = fs.existsSync(ytDlpPath) ? createYoutubeDl(ytDlpPath) : (await import('youtube-dl-exec')).default;

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /shorts\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Use POST' });

  try {
    const { videoUrl, title, tab = 'us', difficulty = 'intermediate', category = 'daily' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ success: false, error: 'videoUrl is required' });

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });

    console.log(`[${videoId}] Starting...`);

    const tmpDir = os.tmpdir();
    const audioPath = path.join(tmpDir, `${videoId}.mp3`);

    console.log(`[${videoId}] Downloading audio...`);
    await youtubeDl(`https://www.youtube.com/watch?v=${videoId}`, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: audioPath.replace('.mp3', '.%(ext)s'),
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
    });

    if (!fs.existsSync(audioPath)) throw new Error('Audio download failed');

    console.log(`[${videoId}] Transcribing with Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    fs.unlinkSync(audioPath);

    const segments = transcription.segments || [];
    if (segments.length === 0) throw new Error('No speech detected');

    const merged = mergeSentences(segments);
    const finalSentences = merged.slice(0, 5);

    console.log(`[${videoId}] Asking Claude...`);
    const enrichedSentences = await enrichWithClaude(finalSentences);

    const catIcons = { interview: '🎤', food: '🍔', daily: '☀️', kpop: '💃', travel: '✈️', business: '👔', drama: '🎭' };

    const lesson = {
      id: videoId,
      title: title || `YouTube Short ${videoId}`,
      cat: category,
      catIcon: catIcons[category] || '📺',
      diff: difficulty,
      dubs: 0,
      sentences: enrichedSentences,
      _tab: tab,
    };

    console.log(`[${videoId}] Done!`);
    return res.status(200).json({ success: true, lesson, language: transcription.language });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ success: false, error: error.message, details: error.stack });
  }
}

function mergeSentences(segments) {
  const merged = [];
  let current = null;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (!current) { current = { start: seg.start, end: seg.end, text }; continue; }
    const duration = current.end - current.start;
    const prevEndsPunct = /[.!?]$/.test(current.text);
    if (duration < 2 && !prevEndsPunct) {
      current.text += ' ' + text;
      current.end = seg.end;
    } else if (duration < 5 && !prevEndsPunct && text.length < 20) {
      current.text += ' ' + text;
      current.end = seg.end;
    } else {
      merged.push(current);
      current = { start: seg.start, end: seg.end, text };
    }
  }
  if (current) merged.push(current);
  return merged.map(s => ({
    start: parseFloat(s.start.toFixed(1)),
    end: parseFloat(s.end.toFixed(1)),
    en: s.text.replace(/\s+/g, ' ').trim(),
  }));
}

async function enrichWithClaude(sentences) {
  const prompt = `You are an expert English-Korean language teacher creating content for a YouTube Shorts dubbing learning app.

For each sentence below, produce a JSON object with:
- en: the English sentence (clean up if needed)
- ko: natural Korean translation (speech-style, not formal)
- core: ONE single English word that is the most important "sticky" content word to remember (noun/verb/adjective, NOT function words like 'the', 'is', 'a')
- highlight: A 2-4 word English chunk/collocation that contains the core word (useful phrase for memorization)
- koHighlight: The Korean translation of the highlight chunk

Sentences:
${sentences.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] "${s.en}"`).join('\n')}

Return ONLY a valid JSON array, no markdown, no explanation. Example:
[{"en":"What do you do?","ko":"직업이 뭐예요?","core":"living","highlight":"for a living","koHighlight":"직업"}]`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);

  return parsed.map((item, i) => ({
    en: item.en || sentences[i]?.en || '',
    ko: item.ko || '',
    start: sentences[i]?.start ?? 0,
    end: sentences[i]?.end ?? 0,
    core: item.core || '',
    highlight: item.highlight || '',
    koHighlight: item.koHighlight || '',
  }));
}