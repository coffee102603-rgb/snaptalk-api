// ============================================================
// SnapTalk API v2.2 — 안정화 (youtube-transcript 제거)
// ============================================================
// 작동 순서:
//   1. 직접 페이지 파싱 (수동 + 자동자막 모두 허용) ← 메인!
//   2. Whisper 백업 (ytdl 가능 시)
//   3. → Claude로 번역 + 교육자료화
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import ytdl from '@distube/ytdl-core';

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Curator-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { videoUrl } = req.body || {};
    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`📹 Processing: ${videoId}`);

    let segments = null;
    let source = null;
    const attempts = [];

    // ========================================
    // STEP 1: 직접 파싱 (수동 + 자동 자막 모두!)
    // ========================================
    try {
      console.log('  1️⃣ Trying direct caption parse...');
      segments = await fetchViaDirectParse(videoId);
      if (segments && segments.length > 0) {
        source = 'direct-parse';
        console.log(`  ✅ Direct parse: ${segments.length} segments`);
      }
    } catch (e) {
      attempts.push(`direct-parse: ${e.message}`);
      console.log(`  ⚠️ Direct parse failed: ${e.message}`);
    }

    // ========================================
    // STEP 2: Whisper 백업
    // ========================================
    if (!segments || segments.length === 0) {
      try {
        console.log('  2️⃣ Trying Whisper (may fail due to YouTube bot detection)...');
        segments = await transcribeWithWhisper(videoUrl);
        source = 'whisper';
        console.log(`  ✅ Whisper: ${segments.length} segments`);
      } catch (e) {
        attempts.push(`whisper: ${e.message}`);
        console.log(`  ❌ Whisper failed: ${e.message}`);
      }
    }

    // ========================================
    // 모든 방법 실패
    // ========================================
    if (!segments || segments.length === 0) {
      return res.status(500).json({
        error: '자막을 가져올 수 없습니다',
        hint: '이 영상은 자막이 전혀 없거나, YouTube가 일시적으로 접근을 차단했을 수 있습니다.',
        attempts,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
      });
    }

    // ========================================
    // STEP 3: Claude로 번역 + 교육자료화
    // ========================================
    console.log('  3️⃣ Generating lesson with Claude...');
    const lesson = await generateLessonWithClaude(segments);
    console.log(`  ✅ Lesson generated: ${lesson.sentences.length} sentences`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`🎉 Done in ${elapsed}s (source: ${source})`);

    res.status(200).json({
      source,
      segmentsCount: segments.length,
      elapsed: elapsed + 's',
      sentences: lesson.sentences
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({
      error: err.message || 'Internal server error',
      stack: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : null,
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
    });
  }
}

// ============================================================
// 유틸: YouTube URL → videoId
// ============================================================
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/shorts\/|youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ============================================================
// STEP 1: 직접 페이지 파싱 (수동 + 자동 자막 허용!)
// ============================================================
async function fetchViaDirectParse(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  if (!response.ok) {
    throw new Error(`Page fetch failed: ${response.status}`);
  }

  const html = await response.text();

  // captionTracks 배열 추출
  const match = html.match(/"captionTracks":(\[[^\]]*\])/);
  if (!match) {
    throw new Error('No caption tracks found in page');
  }

  let tracks;
  try {
    tracks = JSON.parse(match[1]);
  } catch (e) {
    throw new Error('Failed to parse caption tracks JSON');
  }

  if (!tracks || tracks.length === 0) {
    throw new Error('Empty caption tracks');
  }

  // 🔧 v2.2: 수동 자막 우선, 없으면 ASR(자동자막)도 허용!
  const englishTrack =
    // 1. 수동 업로드된 영어 자막 (최고!)
    tracks.find(t =>
      (t.languageCode === 'en' || t.languageCode === 'en-US') &&
      t.kind !== 'asr'
    ) ||
    // 2. 자동 생성 영어 자막 (95% 영상 있음!)
    tracks.find(t =>
      t.languageCode === 'en' || t.languageCode === 'en-US'
    ) ||
    // 3. 영어 계열 자막
    tracks.find(t =>
      t.languageCode && t.languageCode.startsWith('en')
    ) ||
    // 4. 최후의 수단: 첫 번째 트랙
    tracks[0];

  if (!englishTrack || !englishTrack.baseUrl) {
    throw new Error('No usable captions (no baseUrl)');
  }

  console.log(`    📝 Track: lang=${englishTrack.languageCode}, kind=${englishTrack.kind || 'manual'}`);

  // 자막 XML 가져오기
  const captionsResponse = await fetch(englishTrack.baseUrl);
  if (!captionsResponse.ok) {
    throw new Error(`Captions fetch failed: ${captionsResponse.status}`);
  }
  const xml = await captionsResponse.text();

  // XML 파싱
  const segments = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"(?:[^>]*)>([^<]*)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const text = decodeHtmlEntities(m[3]).trim();
    if (!text) continue;

    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    segments.push({
      text,
      start,
      end: start + dur
    });
  }

  if (segments.length === 0) {
    throw new Error('Caption file is empty');
  }

  return segments;
}

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n/g, ' ');
}

// ============================================================
// STEP 2: Whisper 백업 (ytdl 작동 시)
// ============================================================
async function transcribeWithWhisper(videoUrl) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const audioStream = ytdl(videoUrl, {
    filter: 'audioonly',
    quality: 'lowestaudio',
    highWaterMark: 1 << 25
  });

  const chunks = [];
  let totalSize = 0;
  const MAX_SIZE = 25 * 1024 * 1024;

  for await (const chunk of audioStream) {
    chunks.push(chunk);
    totalSize += chunk.length;
    if (totalSize > MAX_SIZE) {
      throw new Error(`Audio too large: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
    }
  }

  const audioBuffer = Buffer.concat(chunks);
  if (audioBuffer.length < 1000) {
    throw new Error('Audio too small');
  }

  const transcription = await openai.audio.transcriptions.create({
    file: await toFile(audioBuffer, 'audio.m4a'),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
    language: 'en'
  });

  const segments = (transcription.segments || [])
    .map(s => ({
      text: s.text.trim(),
      start: s.start,
      end: s.end
    }))
    .filter(s => s.text.length > 0 && s.end > s.start);

  if (segments.length === 0) {
    throw new Error('Whisper returned no segments');
  }

  return segments;
}

// ============================================================
// STEP 3: Claude로 번역 + 교육자료화
// ============================================================
async function generateLessonWithClaude(segments) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const segmentsText = segments.map((s, i) =>
    `${i + 1}. [${s.start.toFixed(1)}~${s.end.toFixed(1)}s] ${s.text}`
  ).join('\n');

  const prompt = `You are an expert English teacher creating lesson content for Korean learners.

Here are the English sentences from a YouTube Short (with timestamps):
${segmentsText}

For EACH sentence, provide:
1. "en": The exact English text (do not modify)
2. "start": start time in seconds (use the timestamp I gave)
3. "end": end time in seconds (use the timestamp I gave)
4. "core": the MOST IMPORTANT content word (noun/verb/adjective only — NO articles like "the", NO pronouns like "I/you", NO be-verbs like "is/are")
5. "highlight": a 2-4 word collocation containing the core word (e.g., "for a living", "look good", "make sense")
6. "translations.ko.text": natural conversational Korean translation
7. "translations.ko.highlight": Korean translation of just the highlight phrase

Return ONLY valid JSON (no markdown, no explanation, no code blocks):

{
  "sentences": [
    {
      "en": "What do you do for a living?",
      "start": 0.5,
      "end": 2.3,
      "core": "living",
      "highlight": "for a living",
      "translations": {
        "ko": {
          "text": "직업이 뭐예요?",
          "highlight": "직업"
        }
      }
    }
  ]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  let text = response.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse Claude response:', text.slice(0, 500));
    throw new Error('Claude returned invalid JSON');
  }

  if (!parsed.sentences || !Array.isArray(parsed.sentences)) {
    throw new Error('Claude response missing sentences array');
  }

  // 타임스탬프 정확성 보장
  parsed.sentences = parsed.sentences.map((s, i) => ({
    ...s,
    start: segments[i] ? segments[i].start : s.start,
    end: segments[i] ? segments[i].end : s.end
  }));

  return parsed;
}
