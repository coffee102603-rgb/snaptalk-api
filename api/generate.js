// ============================================================
// SnapTalk API v2.6 — 완전한 문장 + 촘촘한 청크 마커! 📚🎯
// ============================================================
// 작동 순서:
//   1. Supadata API ⭐ 메인! (Vercel에서도 완벽 작동!)
//   2. 직접 페이지 파싱 (백업 1)
//   3. Whisper (백업 2, ytdl 가능 시)
//   → Claude로 번역 + phonetic + 완전 문장 + 청크 마커
// ============================================================
// v2.6 변경사항:
//   ✨ 문장 길이 제한 없음 — 의미 완결성 우선!
//   ✨ 긴 문장도 나누지 말고 한 통으로 유지
//   ✨ 대신 촘촘한 청크 마커 (3-6 단어마다)
//   ✨ 호흡 단위 = 자연스러운 pause 지점 = TOEIC 끊어읽기!
// v2.5 변경사항:
//   ✨ 짧은 segments를 맥락상 완전한 문장으로 합침
//   ✨ 청크(끊어읽기 단위)에 | 마커 삽입
//   ✨ 영어/한글/phonetic 모두 같은 위치에 | 마커
// v2.4 변경사항:
//   ✨ phonetic 필드 자동 생성 (영어 → 한글 음사)
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import ytdl from '@distube/ytdl-core';
import { Supadata } from '@supadata/js';

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
    // STEP 1: Supadata API ⭐ 메인!
    // ========================================
    try {
      console.log('  1️⃣ Trying Supadata API...');
      segments = await fetchViaSupadata(videoUrl);
      if (segments && segments.length > 0) {
        source = 'supadata';
        console.log(`  ✅ Supadata: ${segments.length} segments`);
      }
    } catch (e) {
      attempts.push(`supadata: ${e.message}`);
      console.log(`  ⚠️ Supadata failed: ${e.message}`);
    }

    // ========================================
    // STEP 2: 직접 파싱 (백업 1)
    // ========================================
    if (!segments || segments.length === 0) {
      try {
        console.log('  2️⃣ Trying direct caption parse...');
        segments = await fetchViaDirectParse(videoId);
        if (segments && segments.length > 0) {
          source = 'direct-parse';
          console.log(`  ✅ Direct parse: ${segments.length} segments`);
        }
      } catch (e) {
        attempts.push(`direct-parse: ${e.message}`);
        console.log(`  ⚠️ Direct parse failed: ${e.message}`);
      }
    }

    // ========================================
    // STEP 3: Whisper (백업 2)
    // ========================================
    if (!segments || segments.length === 0) {
      try {
        console.log('  3️⃣ Trying Whisper (may fail due to YouTube bot detection)...');
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
        hint: '이 영상은 자막이 전혀 없거나, 접근이 제한되어 있습니다.',
        attempts,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
      });
    }

    // ========================================
    // STEP 4: Claude로 번역 + 교육자료화
    // ========================================
    console.log('  4️⃣ Generating lesson with Claude...');
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
// STEP 1: Supadata API ⭐
// ============================================================
async function fetchViaSupadata(videoUrl) {
  if (!process.env.SUPADATA_API_KEY) {
    throw new Error('SUPADATA_API_KEY not configured');
  }

  const supadata = new Supadata({ apiKey: process.env.SUPADATA_API_KEY });

  // mode: 'auto' = 수동 자막 먼저, 없으면 AI 생성
  const result = await supadata.transcript({
    url: videoUrl,
    lang: 'en',
    mode: 'auto'
  });

  // 비동기 작업 처리 (20분+ 영상)
  if ('jobId' in result) {
    console.log(`    ⏳ Async job started: ${result.jobId}`);
    // 최대 55초 폴링 (Vercel 60초 제한)
    for (let i = 0; i < 55; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const jobResult = await supadata.transcript.getJobStatus(result.jobId);
      
      if (jobResult.status === 'completed') {
        return convertSupadataToSegments(jobResult.content);
      } else if (jobResult.status === 'failed') {
        throw new Error(`Supadata job failed: ${jobResult.error}`);
      }
      // queued, in_progress: 계속 대기
    }
    throw new Error('Supadata job timeout (55s)');
  }

  // 즉시 결과
  return convertSupadataToSegments(result.content);
}

function convertSupadataToSegments(content) {
  if (!content) {
    throw new Error('Supadata returned no content');
  }

  // content가 string이면 (text: true 모드)
  if (typeof content === 'string') {
    throw new Error('Supadata returned plain text (need timestamps)');
  }

  // content가 array of segments (timestamped mode)
  if (!Array.isArray(content)) {
    throw new Error('Supadata returned unexpected format');
  }

  const segments = content.map(seg => {
    // offset/duration이 ms 단위 vs 초 단위 대응
    const offsetMs = seg.offset || 0;
    const durationMs = seg.duration || 0;
    
    // 보통 ms로 옴. 큰 숫자면 ms로 간주
    const isMs = offsetMs > 100 || durationMs > 100;
    
    const start = isMs ? offsetMs / 1000 : offsetMs;
    const duration = isMs ? durationMs / 1000 : durationMs;

    return {
      text: String(seg.text || '').trim(),
      start,
      end: start + duration
    };
  }).filter(s => s.text.length > 0 && s.end > s.start);

  if (segments.length === 0) {
    throw new Error('Supadata returned empty segments');
  }

  return segments;
}

// ============================================================
// STEP 2: 직접 페이지 파싱 (백업)
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
  const match = html.match(/"captionTracks":(\[[^\]]*\])/);
  if (!match) {
    throw new Error('No caption tracks found');
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

  const englishTrack =
    tracks.find(t => (t.languageCode === 'en' || t.languageCode === 'en-US') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode === 'en' || t.languageCode === 'en-US') ||
    tracks.find(t => t.languageCode && t.languageCode.startsWith('en')) ||
    tracks[0];

  if (!englishTrack || !englishTrack.baseUrl) {
    throw new Error('No usable captions');
  }

  const captionsResponse = await fetch(englishTrack.baseUrl);
  if (!captionsResponse.ok) {
    throw new Error(`Captions fetch failed: ${captionsResponse.status}`);
  }
  const xml = await captionsResponse.text();

  const segments = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"(?:[^>]*)>([^<]*)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const text = decodeHtmlEntities(m[3]).trim();
    if (!text) continue;
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    segments.push({ text, start, end: start + dur });
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
// STEP 3: Whisper 백업
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
    .map(s => ({ text: s.text.trim(), start: s.start, end: s.end }))
    .filter(s => s.text.length > 0 && s.end > s.start);

  if (segments.length === 0) {
    throw new Error('Whisper returned no segments');
  }

  return segments;
}

// ============================================================
// STEP 4: Claude로 번역 + 교육자료화
// ============================================================
async function generateLessonWithClaude(segments) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 긴 영상 대응: 최대 30문장만 처리 (Claude 토큰 제한)
  const workingSegments = segments.slice(0, 30);
  const isPartial = segments.length > 30;

  const segmentsText = workingSegments.map((s, i) =>
    `${i + 1}. [${s.start.toFixed(1)}~${s.end.toFixed(1)}s] ${s.text}`
  ).join('\n');

  const prompt = `You are an expert English teacher creating lesson content for Korean learners studying with the "shadowing + chunking" method (used by TOEIC instructors for 15+ years).

Here are raw YouTube caption segments (short, often cut mid-sentence):
${segmentsText}

YOUR JOB:
1. MERGE these short segments into COMPLETE, meaningful English sentences.
2. DO NOT split long sentences — keep them WHOLE even if lengthy (that's the WHOLE POINT for learning!).
3. Add chunk markers "|" at natural reading/breath breaks FREQUENTLY (every 3-6 words).
4. Provide Korean translation with SAME chunk markers at matching positions.
5. Provide phonetic (Korean pronunciation) with SAME chunk markers at matching positions.

CRITICAL RULES ABOUT SENTENCE LENGTH:
- Long sentences are GOOD — they preserve real meaning and force learners to think in English.
- Example: "$250 a night so it's not cheap but to have the whole experience walking through the Princess Cruise's 12-day Vancouver-to-Alaska voyage it's absolutely worth it"
  → KEEP as ONE sentence with MANY chunk markers!
- NEVER cut a complete thought into 2+ sentences just because it's long.
- The chunk markers (|) let learners read it comfortably despite length.

CHUNK MARKER RULES (VERY IMPORTANT):
- Use " | " (space-pipe-space) between chunks
- A chunk = natural breath unit, typically 3-6 words (be GENEROUS with markers!)
- Break at: after subject, before verbs/objects, before prepositional phrases, before "that/which/and/but/so", after commas
- The number of | marks must be IDENTICAL across en, ko, and phonetic
- Short sentences (1-5 words) need NO markers
- A 20-word sentence should have 4-6 markers for easy reading

EXAMPLES:

Short → no markers:
  en: "What is this?"
  ko: "이게 뭐예요?"
  phonetic: "왓 이즈 디스?"

Medium → 1-2 markers:
  en: "I went to the store | yesterday."
  ko: "저는 가게에 갔어요 | 어제요."
  phonetic: "아이 웬트 투 더 스토어 | 예스터데이."

Long → MANY markers (KEEP AS ONE SENTENCE!):
  en: "$250 a night, | so it's not cheap, | but to have the whole experience, | walking through the entire ship, | it's absolutely worth it."
  ko: "하루에 $250이라서, | 싸진 않지만, | 전체 경험을 해보고, | 배 전체를 둘러보기엔, | 정말 가치 있어요."
  phonetic: "투 헌드레드 피프티 어 나잇, | 쏘 잇츠 낫 칩, | 벗 투 해브 더 홀 익스피리언스, | 워킹 쓰루 디 엔타이어 쉽, | 잇츠 앱솔루틀리 워쓰 잇."

For EACH merged sentence, provide:
1. "en": Complete English sentence (NO splitting!) with frequent | markers
2. "start": Start time (of the first original segment merged)
3. "end": End time (of the last original segment merged)
4. "core": MOST IMPORTANT content word (noun/verb/adjective only — NO articles, NO pronouns, NO be-verbs)
5. "highlight": A 2-4 word collocation containing the core word
6. "phonetic": Korean phonetic with SAME | markers as "en" (standard textbook transcription)
7. "translations.ko.text": Natural Korean with SAME | markers as "en"
8. "translations.ko.highlight": Korean translation of just the highlight

Return ONLY valid JSON (no markdown, no code blocks, no explanation):

{
  "sentences": [
    {
      "en": "I work in finance | downtown | near the station.",
      "start": 0.5,
      "end": 3.2,
      "core": "finance",
      "highlight": "work in finance",
      "phonetic": "아이 워크 인 파이낸스 | 다운타운 | 니어 더 스테이션.",
      "translations": {
        "ko": {
          "text": "저는 금융 일을 해요 | 다운타운에서 | 역 근처에요.",
          "highlight": "금융 일을 해요"
        }
      }
    }
  ]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
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

  // v2.5: 문장이 합쳐졌으므로 Claude가 반환한 타임스탬프를 신뢰
  // (Claude는 합쳐진 문장의 시작/끝 범위를 반환)
  // 유효성 검증만 수행: 범위 벗어나면 안전하게 클램핑
  const firstSegStart = workingSegments[0]?.start ?? 0;
  const lastSegEnd = workingSegments[workingSegments.length - 1]?.end ?? 999;

  parsed.sentences = parsed.sentences.map((s) => {
    let start = typeof s.start === 'number' ? s.start : firstSegStart;
    let end = typeof s.end === 'number' ? s.end : lastSegEnd;
    // 안전 장치: 범위 밖이면 클램핑
    if (start < 0) start = 0;
    if (end <= start) end = start + 2; // 최소 2초
    if (start < firstSegStart - 1) start = firstSegStart;
    if (end > lastSegEnd + 1) end = lastSegEnd;
    return { ...s, start, end };
  });

  if (isPartial) {
    parsed.note = `Merged from ${segments.length} raw segments into ${parsed.sentences.length} sentences`;
  }

  return parsed;
}
