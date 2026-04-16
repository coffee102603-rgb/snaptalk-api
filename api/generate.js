import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [/shorts\/([A-Za-z0-9_-]{11})/, /[?&]v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/, /^([A-Za-z0-9_-]{11})$/];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

async function fetchTranscript(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
  const html = await res.text();
  const captionMatch = html.match(/"captionTracks":\[(.*?)\]/);
  if (!captionMatch) return null;
  const tracks = JSON.parse(`[${captionMatch[1]}]`);
  const enTrack = tracks.find(t => t.languageCode === 'en') || tracks.find(t => t.languageCode && t.languageCode.startsWith('en')) || tracks[0];
  if (!enTrack || !enTrack.baseUrl) return null;
  const captionRes = await fetch(enTrack.baseUrl);
  const xml = await captionRes.text();
  const segments = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    segments.push({ start: parseFloat(match[1]), duration: parseFloat(match[2]), text: match[3].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,'').trim() });
  }
  return { segments, language: enTrack.languageCode || 'en' };
}

function mergeSentences(segments) {
  const merged = [];
  let current = null;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (!current) { current = { start: seg.start, end: seg.start + seg.duration, text }; continue; }
    const dur = current.end - current.start;
    const endsPunct = /[.!?]$/.test(current.text);
    if (dur < 3 && !endsPunct) { current.text += ' ' + text; current.end = seg.start + seg.duration; }
    else { merged.push(current); current = { start: seg.start, end: seg.start + seg.duration, text }; }
  }
  if (current) merged.push(current);
  return merged.map(s => ({ start: parseFloat(s.start.toFixed(1)), end: parseFloat(s.end.toFixed(1)), en: s.text.replace(/\s+/g,' ').trim() }));
}

async function enrichWithClaude(sentences) {
  const prompt = `You are an expert English-Korean language teacher. For each sentence, return a JSON object:
- en: English sentence (cleaned)
- ko: natural Korean translation (casual speech style)
- core: ONE important content word (noun/verb/adj, NOT function words)
- highlight: 2-4 word English chunk containing the core
- koHighlight: Korean translation of the highlight

Sentences:
${sentences.map((s, i) => `${i+1}. [${s.start}s] "${s.en}"`).join('\n')}

Return ONLY valid JSON array. Example:
[{"en":"What do you do?","ko":"직업이 뭐예요?","core":"living","highlight":"for a living","koHighlight":"직업"}]`;

  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
  const text = r.content[0].text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
  const parsed = JSON.parse(text);
  return parsed.map((item, i) => ({ en: item.en || sentences[i]?.en || '', ko: item.ko || '', start: sentences[i]?.start ?? 0, end: sentences[i]?.end ?? 0, core: item.core || '', highlight: item.highlight || '', koHighlight: item.koHighlight || '' }));
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

    const transcript = await fetchTranscript(videoId);
    if (!transcript || transcript.segments.length === 0) return res.status(400).json({ success: false, error: 'No captions found for this video. Try a video with English subtitles.' });

    const merged = mergeSentences(transcript.segments);
    const final = merged.slice(0, 5);
    const enriched = await enrichWithClaude(final);

    const catIcons = { interview: '🎤', food: '🍔', daily: '☀️', kpop: '💃', travel: '✈️', business: '👔', drama: '🎭' };
    const lesson = { id: videoId, title: title || `YouTube Short`, cat: category, catIcon: catIcons[category] || '📺', diff: difficulty, dubs: 0, sentences: enriched, _tab: tab };

    return res.status(200).json({ success: true, lesson, language: transcript.language });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}