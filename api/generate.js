// ============================================================
// SnapTalk API v3.1 — 청크 분절 완전 정복! 주어+동사+관사+조동사 절대 보호 🎯📚
// ============================================================
// 작동 순서:
//   1. Supadata API ⭐ 메인! (Vercel에서도 완벽 작동!)
//   2. 직접 페이지 파싱 (백업 1)
//   3. Whisper (백업 2, ytdl 가능 시)
//   → Claude로 번역 + phonetic + 완전 문장 + 청크 마커
// ============================================================
// v3.1 변경사항 (CEO 직접 발견한 문제 + 5가지 새 규칙):
//   🔥 RULE 4 대폭 강화 — 주어+동사 절대 분리 금지!
//      BAD: "I | am not doing this" ❌
//      GOOD: "I am not doing this" ✅
//   🆕 RULE 6: 조동사+본동사 분리 금지!
//      BAD: "I will | go" ❌
//      GOOD: "I will go" ✅
//   🆕 RULE 7: 최소 청크 길이 (3단어 이상 권장)
//   🆕 RULE 8: 관사+명사 분리 금지!
//      BAD: "the | car" ❌
//      GOOD: "the car" ✅
//   🆕 RULE 9: 관계대명사/접속사 앞에서 끊기!
//      GOOD: "the book | that I read" ✅
//   🎯 12가지 BAD vs GOOD 예시 (기존 6개 + 신규 6개)
// ============================================================
// v3.0 변경사항 (특허 #1 기반):
//   🎯 구동사(phrasal verbs) 절대 분리 금지!
//      예: run out, pick up, look for, find out, give up
//   🎯 감탄사/대답어 독립 청크 명시!
//      예: Okay. | Yeah | Well | Oh | Wow
//   🎯 부사 독립 청크 강화!
//      예: Hopefully | Actually | Suddenly | Finally
//   🎯 잘못된 예시 (BAD examples) 추가로 AI 학습 강화!
//   🎯 의미 단위 우선 — 통사적 분절보다 의미적 분절!
// ============================================================
// v2.6 변경사항:
//   ✨ 문장 길이 제한 없음 — 의미 완결성 우선!
//   ✨ 긴 문장도 나누지 말고 한 통으로 유지
//   ✨ 대신 촘촘한 청크 마커 (3-6 단어마다)
// v2.5 변경사항:
//   ✨ 짧은 segments를 맥락상 완전한 문장으로 합침
//   ✨ 청크(끊어읽기 단위)에 | 마커 삽입
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
    const { videoUrl, region = 'us' } = req.body || {};
    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }
    const isKorean = region === 'kr';
    console.log('  🌐 Region:', region, isKorean ? '(한국어 학습 모드)' : '(영어 학습 모드)');

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
      segments = await fetchViaSupadata(videoUrl, isKorean);
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
        segments = await fetchViaDirectParse(videoId, isKorean);
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
        segments = await transcribeWithWhisper(videoUrl, isKorean);
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
    // v3.2: 긴 영상 504 타임아웃 방지 — 최대 35개 segments만 처리
    const MAX_SEGMENTS = 15;
    let segmentsToProcess = segments;
    if (segments.length > MAX_SEGMENTS) {
      console.log(`  ✂️ 긴 영상! ${segments.length}개 → 앞 ${MAX_SEGMENTS}개만 처리`);
      segmentsToProcess = segments.slice(0, MAX_SEGMENTS);
    }
    const lesson = await generateLessonWithClaude(segmentsToProcess, isKorean);
    console.log(`  ✅ Lesson generated: ${lesson.sentences.length} sentences`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`🎉 Done in ${elapsed}s (source: ${source})`);

    res.status(200).json({
      source,
      segmentsCount: segments.length,
      elapsed: elapsed + 's',
      sentences: lesson.sentences,
      /* 🆕 원본 세그먼트 타이밍 (앱에서 정확한 청크 시간 계산용) */
      rawSegments: segmentsToProcess.map(function(s){
        return { text: s.text, start: s.start, end: s.end };
      })
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
async function fetchViaSupadata(videoUrl, isKorean = false) {
  if (!process.env.SUPADATA_API_KEY) {
    throw new Error('SUPADATA_API_KEY not configured');
  }

  const supadata = new Supadata({ apiKey: process.env.SUPADATA_API_KEY });

  // mode: 'auto' = 수동 자막 먼저, 없으면 AI 생성
  const result = await supadata.transcript({
    url: videoUrl,
    lang: isKorean ? 'ko' : 'en',
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
async function fetchViaDirectParse(videoId, isKorean = false) {
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

  let chosenTrack;
  if (isKorean) {
    chosenTrack =
      tracks.find(t => (t.languageCode === 'ko' || t.languageCode === 'ko-KR') && t.kind !== 'asr') ||
      tracks.find(t => t.languageCode === 'ko' || t.languageCode === 'ko-KR') ||
      tracks.find(t => t.languageCode && t.languageCode.startsWith('ko')) ||
      tracks[0];
  } else {
    chosenTrack =
      tracks.find(t => (t.languageCode === 'en' || t.languageCode === 'en-US') && t.kind !== 'asr') ||
      tracks.find(t => t.languageCode === 'en' || t.languageCode === 'en-US') ||
      tracks.find(t => t.languageCode && t.languageCode.startsWith('en')) ||
      tracks[0];
  }

  if (!chosenTrack || !chosenTrack.baseUrl) {
    throw new Error('No usable captions');
  }

  const captionsResponse = await fetch(chosenTrack.baseUrl);
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
async function transcribeWithWhisper(videoUrl, isKorean = false) {
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
    language: isKorean ? 'ko' : 'en'
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
async function generateLessonWithClaude(segments, isKorean = false) {
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

  const koreanPrompt = `You are an expert Korean-language teacher creating lesson content for ENGLISH-SPEAKING learners studying Korean with the "shadowing + chunking" method.

Here are raw YouTube caption segments in KOREAN (short, often cut mid-sentence):
${segmentsText}

YOUR JOB (Korean learning mode):
1. MERGE these short segments into COMPLETE, natural Korean sentences.
2. Add chunk markers "|" at meaningful breath/pause points in the KOREAN sentence.
3. For each sentence provide:
   - "ko": the complete KOREAN sentence with chunk markers (THIS IS THE MAIN TEXT to learn)
   - "phonetic": ROMANIZATION of the Korean (Revised Romanization of Korean), with SAME chunk markers
   - "en": natural ENGLISH translation (the meaning), with SAME chunk markers
   - "start"/"end": timing
   - "core": most important Korean content word
   - "highlight": 2-4 word key Korean phrase containing the core
   - "translations.en.highlight": English meaning of the highlight

ROMANIZATION RULES (Revised Romanization):
- 안녕하세요 → annyeonghaseyo
- 제주도 → jejudo
- 먹방 → meokbang
- 감사합니다 → gamsahamnida
- Use spaces between words, lowercase, no diacritics

CHUNK RULES:
- 3-6 단어(eojeol) per chunk
- Break at natural particle/phrase boundaries (~은/는, ~을/를, ~에서, ~고, ~지만)
- Same number of "|" in ko, phonetic, and en

Return ONLY valid JSON (no markdown):
{
  "sentences": [
    {
      "ko": "요즘 제주도를 | 2박 3일로 여행하면 | 얼마나 들까요?",
      "phonetic": "yojeum jejudoreul | ibak samilro yeohaenghamyeon | eolmana deulkkayo?",
      "en": "How much would it cost | to travel to Jeju Island | for 2 nights and 3 days these days?",
      "start": 0.1,
      "end": 3.6,
      "core": "여행",
      "highlight": "제주도를 여행하다",
      "translations": { "en": { "highlight": "travel to Jeju Island" } }
    }
  ]
}`;

  const englishPrompt = `You are an expert English teacher creating lesson content for Korean learners studying with the "shadowing + chunking" method (used by TOEIC instructors for 15+ years).

Here are raw YouTube caption segments (short, often cut mid-sentence):
${segmentsText}

YOUR JOB:
1. MERGE these short segments into COMPLETE, meaningful English sentences.
2. DO NOT split long sentences — keep them WHOLE even if lengthy (that's the WHOLE POINT for learning!).
3. Add chunk markers "|" at MEANINGFUL breath/pause points (every 3-6 words).
4. Provide Korean translation with SAME chunk markers at matching positions.
5. Provide phonetic (Korean pronunciation) with SAME chunk markers at matching positions.

═══════════════════════════════════════════════
🚨 CRITICAL CHUNK RULES (NEVER VIOLATE!) 🚨
v3.1: 9 RULES (was 5) — More strict, more examples!
═══════════════════════════════════════════════

⛔ RULE 1: NEVER SPLIT PHRASAL VERBS!
Phrasal verbs are TWO-word verbs where the second word changes meaning.
BAD: "I do not run | out."   ❌ (split!)
GOOD: "I do not run out."    ✅ (kept together!)

Common phrasal verbs (NEVER split these):
- run out (다 떨어지다)      - pick up (집어들다)
- look for (찾다)            - find out (알아내다)
- give up (포기하다)         - turn on/off (켜다/끄다)
- get up (일어나다)          - sit down (앉다)
- come back (돌아오다)       - go away (가버리다)
- take off (벗다/이륙)       - put on (입다)
- show up (나타나다)         - work out (운동/잘되다)
- check out (확인하다)       - hang out (놀다)
- end up (결국~되다)         - figure out (알아내다)

⛔ RULE 2: INTERJECTIONS = STANDALONE CHUNKS!
Interjections/response words MUST be their own chunk.
BAD: "Okay. Hopefully I do not run out."           ❌ (no markers!)
GOOD: "Okay. | Hopefully | I do not run out."      ✅ (3 chunks!)

Common interjections (always standalone):
- Okay / OK              - Yeah / Yes / Yep
- Well / Hmm             - Oh / Wow / Hey
- Right / Sure / Alright - Actually / Honestly

⛔ RULE 3: ADVERBS OFTEN STAND ALONE!
Sentence-initial adverbs are independent chunks.
BAD: "Hopefully I do not run out."         ❌ 
GOOD: "Hopefully | I do not run out."      ✅

Common standalone adverbs:
- Hopefully / Actually / Surprisingly
- Finally / Suddenly / Eventually
- Honestly / Basically / Obviously
- Unfortunately / Fortunately

⛔ RULE 4 (CRITICAL!): NEVER SEPARATE SUBJECT FROM VERB!
🔥 THIS IS THE MOST IMPORTANT RULE 🔥
The subject pronoun MUST stay with its verb. NO EXCEPTIONS!

BAD examples (NEVER do this!):
❌ "I | am serious"            (I + am must stay together!)
❌ "I | am not doing this"     (I + am not must stay together!)
❌ "He | is happy"             (He + is must stay together!)
❌ "She | was running"         (She + was must stay together!)
❌ "They | were tired"         (They + were must stay together!)
❌ "We | have arrived"         (We + have must stay together!)
❌ "It | is mine"              (It + is must stay together!)
❌ "You | are right"           (You + are must stay together!)

GOOD examples:
✅ "I am serious"               (S+V together)
✅ "I am not doing this"        (S+V+O together)
✅ "He is happy"                (S+V+C together)
✅ "this is the last time. | I am not doing this again."   (split BEFORE I, not after!)

REMEMBER: Pronouns (I, You, He, She, It, We, They) ALWAYS bond with their verb!

⛔ RULE 5: KEEP CORE S+V+O TOGETHER!
The complete S+V+O unit should not be split internally.
BAD: "I | do not run out."                 ❌ (subject separated!)
GOOD: "I do not run out."                  ✅ (kept together)
GOOD: "I do not run out | of milk."        ✅ (split before prep phrase)

⛔ RULE 6 (NEW!): NEVER SEPARATE AUXILIARY VERBS FROM MAIN VERBS!
Modal/auxiliary verbs must stay with their main verb.

BAD examples:
❌ "I will | go to school"      (will + go must stay together!)
❌ "She can | swim fast"        (can + swim must stay together!)
❌ "We have | finished"         (have + finished must stay together!)
❌ "They might | come back"     (might + come must stay together!)
❌ "You should | try this"      (should + try must stay together!)

GOOD examples:
✅ "I will go | to school"      (split BEFORE prep phrase)
✅ "She can swim | very fast"   (split BEFORE adverb)
✅ "We have finished | the work" (split BEFORE object)

Auxiliary verbs that must NEVER be separated:
will / would / can / could / shall / should / may / might / must
have / has / had / do / does / did / am / is / are / was / were / be / been / being

⛔ RULE 7 (NEW!): MINIMUM CHUNK LENGTH — AVOID TOO-SHORT CHUNKS!
Each chunk should ideally be 3+ words. Avoid creating 1-2 word chunks unless:
- It's a sentence-initial interjection (Okay, Yeah, Well)
- It's a sentence-initial adverb (Hopefully, Actually)
- It's a deliberate dramatic pause

BAD examples:
❌ "I | am | not | doing | this"   (way too fragmented!)
❌ "the | book | is | red"          (every word separated!)
❌ "He | said | that | he | left"   (no rhythm at all!)

GOOD examples:
✅ "I am not doing this"
✅ "the book is red"
✅ "He said that he left"
✅ "He said | that he left"   (split before that-clause is OK!)

⛔ RULE 8 (NEW!): NEVER SEPARATE ARTICLES/DETERMINERS FROM NOUNS!
Articles (the, a, an) and determiners (this, that, these, my, your) bond with their noun.

BAD examples:
❌ "the | car is fast"           (the + car must stay together!)
❌ "a | book"                    (a + book must stay together!)
❌ "this | morning"              (this + morning must stay together!)
❌ "my | friend"                 (my + friend must stay together!)
❌ "these | apples"              (these + apples must stay together!)

GOOD examples:
✅ "the car is fast"
✅ "a book"
✅ "this morning | I went out"   (split AFTER the noun phrase, not inside!)
✅ "my friend | is happy"        (split BEFORE verb is OK)

⛔ RULE 9 (NEW!): BREAK BEFORE RELATIVE PRONOUNS & CONJUNCTIONS!
Natural break points are BEFORE these connecting words (not inside the main clause).

Break BEFORE (good places to break):
- that / which / who / whom / whose / where / when
- and / but / so / because / although / while / if / when

BAD examples:
❌ "the book that | I read"       (split inside the relative clause)
❌ "I went out and | met him"     (split right after conjunction)

GOOD examples:
✅ "the book | that I read"       (split BEFORE that-clause)
✅ "I went out | and met him"     (split BEFORE conjunction)
✅ "He left | because he was late" (split BEFORE because-clause)
✅ "She is the one | who I love"   (split BEFORE who-clause)

⛔ RULE 10: PREPOSITIONAL PHRASES = ONE CHUNK!
"to/in/on/at/for/with + ..." stay together.
BAD: "I went to | the store."              ❌ 
GOOD: "I went | to the store."             ✅
GOOD: "I went to the store | yesterday."   ✅

═══════════════════════════════════════════════
✅ COMPLETE EXAMPLES — STUDY CAREFULLY!
12 examples (was 6) — More learning data!
═══════════════════════════════════════════════

Example 1 — Interjection + Adverb + Phrasal Verb:
  ❌ BAD:  "Okay. Hopefully I do not run | out."
  ✅ GOOD: "Okay. | Hopefully | I do not run out."
  Korean:  "오케이. | 다행히 | 다 떨어지지 않길 바라."
  Phonetic:"오케이. | 호프풀리 | 아이 두 낫 런 아웃."

Example 2 — Multiple Phrasal Verbs:
  ❌ BAD:  "I need to look | for my keys and pick | them up."
  ✅ GOOD: "I need to look for my keys | and pick them up."
  Korean:  "내 열쇠를 찾아야 해 | 그리고 집어들어야 해."

Example 3 — Short sentence (no markers needed):
  en: "What is this?"
  ko: "이게 뭐예요?"

Example 4 — Medium sentence (1-2 markers):
  en: "I went to the store | yesterday afternoon."
  ko: "저는 가게에 갔어요 | 어제 오후에."
  phonetic: "아이 웬트 투 더 스토어 | 예스터데이 애프터눈."

Example 5 — Long sentence (MANY markers, KEEP AS ONE!):
  en: "$250 a night, | so it's not cheap, | but to have the whole experience, | walking through the entire ship, | it's absolutely worth it."
  ko: "하루에 $250이라서, | 싸진 않지만, | 전체 경험을 해보고, | 배 전체를 둘러보기엔, | 정말 가치 있어요."
  phonetic: "투 헌드레드 피프티 어 나잇, | 쏘 잇츠 낫 칩, | 벗 투 해브 더 홀 익스피리언스, | 워킹 쓰루 디 엔타이어 쉽, | 잇츠 앱솔루틀리 워쓰 잇."

Example 6 — Squid Game Dalgona:
  en: "It is made by melting down sugar | until it turns caramel color | and then adding | a few pinches of baking soda."
  ko: "설탕을 녹여서 만들어요 | 카라멜 색이 될 때까지 | 그리고 넣어주면 | 베이킹 소다를 몇 꼬집."

🆕 Example 7 — Subject+Verb NEVER SPLIT (MrBeast scene!):
  ❌ BAD:  "Jimmy, | I am serious, | this is the last time. | I | am not doing this again."
                                                          ↑ NEVER split I from am!
  ✅ GOOD: "Jimmy, | I am serious, | this is the last time. | I am not doing this again."
  Korean:  "지미, | 나 진심이야, | 이번이 마지막이야. | 다시는 안 할 거야."
  Phonetic:"지미, | 아임 시리어스, | 디스 이즈 더 라스트 타임. | 아임 낫 두잉 디스 어게인."

🆕 Example 8 — Auxiliary Verbs Must Stay Together:
  ❌ BAD:  "I will | go to the store, | and she can | come too."
  ✅ GOOD: "I will go | to the store, | and she can come too."
  Korean:  "나는 갈 거야 | 가게에, | 그리고 그녀도 올 수 있어."

🆕 Example 9 — Articles Stay With Nouns:
  ❌ BAD:  "the | book on the table | is mine."
  ✅ GOOD: "the book on the table | is mine."
  Korean:  "테이블 위의 책은 | 내 거야."

🆕 Example 10 — Break Before Relative Pronoun:
  ❌ BAD:  "the song that I | love is playing."
  ✅ GOOD: "the song | that I love | is playing."
  Korean:  "그 노래 | 내가 좋아하는 | 지금 나오고 있어."

🆕 Example 11 — Break Before Conjunction (not after):
  ❌ BAD:  "I went out and | met my friend at the park."
  ✅ GOOD: "I went out | and met my friend | at the park."
  Korean:  "나는 나갔어 | 그리고 친구를 만났어 | 공원에서."

🆕 Example 12 — Multiple subjects with verbs (each S+V intact):
  ❌ BAD:  "He | said that she | was happy because they | were together."
  ✅ GOOD: "He said | that she was happy | because they were together."
  Korean:  "그가 말했어 | 그녀가 행복하다고 | 왜냐하면 그들이 함께였으니까."

═══════════════════════════════════════════════
📝 CHUNK MARKER SYNTAX
═══════════════════════════════════════════════
- Use " | " (space-pipe-space) between chunks
- A chunk = natural breath unit, typically 3-6 words (be GENEROUS!)
- The number of | marks must be IDENTICAL across en, ko, and phonetic
- Short sentences (1-5 words) need NO markers
- A 20-word sentence should have 4-6 markers for easy reading
- Break BEFORE: prepositional phrases, "that/which/and/but/so/because", relative pronouns
- Break AFTER: interjections, sentence-initial adverbs, commas
- NEVER break: phrasal verbs, articles+noun, possessive+noun, subject+verb, aux+main verb

🔥 v3.1 ABSOLUTE PROHIBITIONS (Will get rejected!):
1. "I | am ..." or any pronoun separated from its verb
2. "the | car" or any article separated from noun
3. "will | go" or any auxiliary separated from main verb
4. "run | out" or any phrasal verb split
5. Chunks of single words (unless interjection/sentence-initial adverb)

For EACH merged sentence, provide:
1. "en": Complete English sentence (NO splitting!) with chunk markers per rules above
2. "start": Start time (of the first original segment merged)
3. "end": End time (of the last original segment merged)
4. "core": MOST IMPORTANT content word (noun/verb/adjective only — NO articles, NO pronouns, NO be-verbs, NO interjections like "Okay")
5. "highlight": A 2-4 word collocation containing the core word (if phrasal verb, include BOTH words!)
6. "phonetic": Korean phonetic with SAME | markers as "en" (standard textbook transcription)
7. "translations.ko.text": Natural Korean with SAME | markers as "en"
8. "translations.ko.highlight": Korean translation of just the highlight

Return ONLY valid JSON (no markdown, no code blocks, no explanation):

{
  "sentences": [
    {
      "en": "Okay. | Hopefully | I do not run out.",
      "start": 37.4,
      "end": 38.8,
      "core": "run out",
      "highlight": "run out",
      "phonetic": "오케이. | 호프풀리 | 아이 두 낫 런 아웃.",
      "translations": {
        "ko": {
          "text": "오케이. | 다행히 | 다 떨어지지 않길 바라.",
          "highlight": "다 떨어지다"
        }
      }
    }
  ]
}`;

  const prompt = isKorean ? koreanPrompt : englishPrompt;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
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

  // ① 1차 클램핑: 각 문장 시간을 원본 범위 안으로
  parsed.sentences = parsed.sentences.map((s) => {
    let start = typeof s.start === 'number' ? s.start : firstSegStart;
    let end = typeof s.end === 'number' ? s.end : lastSegEnd;
    if (start < 0) start = 0;
    if (start < firstSegStart - 1) start = firstSegStart;
    if (end > lastSegEnd + 1) end = lastSegEnd;
    if (end <= start) end = start + 1.5;
    return { ...s, start, end };
  });

  // ② 시작 시간 순으로 정렬 (Claude가 순서를 섞었을 수 있음)
  parsed.sentences.sort((a, b) => a.start - b.start);

  // ③ 순차 보정: 겹침/역행 제거
  //    - 다음 문장 시작은 이전 문장 끝 이상이어야 함
  //    - 각 문장은 최소 1.2초, 단어 수 비례 최소 길이 보장
  for (let i = 0; i < parsed.sentences.length; i++) {
    const cur = parsed.sentences[i];
    const prev = i > 0 ? parsed.sentences[i - 1] : null;

    // 단어 수 기반 권장 최소 길이 (단어당 0.3초, 최소 1.2초)
    const wordCount = ((isKorean ? cur.ko : cur.en) || '').split(/\s+/).filter(Boolean).length;
    const minDur = Math.max(1.2, wordCount * 0.3);

    // 이전 문장 끝보다 시작이 빠르면(겹침/역행) → 이전 끝으로 밀기
    if (prev && cur.start < prev.end) {
      cur.start = prev.end;
    }

    // 끝이 시작보다 빠르거나 너무 짧으면 → 최소 길이 보장
    if (cur.end <= cur.start) {
      cur.end = cur.start + minDur;
    }

    // 다음 문장이 있으면, 끝이 다음 시작을 넘지 않게 (단, 최소 길이는 지킴)
    const next = i < parsed.sentences.length - 1 ? parsed.sentences[i + 1] : null;
    if (next && typeof next.start === 'number' && cur.end > next.start) {
      // 다음 시작 전까지로 줄이되, 최소 길이보다 작아지면 그대로 둠(겹침 허용 < 역행 방지 우선)
      const trimmed = next.start;
      if (trimmed > cur.start + 0.5) {
        cur.end = trimmed;
      }
    }

    // 전체 영상 범위 밖으로 나가지 않게
    if (cur.end > lastSegEnd + 1) cur.end = lastSegEnd;
    if (cur.start > lastSegEnd) cur.start = Math.max(firstSegStart, lastSegEnd - minDur);

    // 소수점 1자리로 정리
    cur.start = Math.round(cur.start * 10) / 10;
    cur.end = Math.round(cur.end * 10) / 10;
  }

  // ④ 🎯 rawSegments 단어겹침 매칭으로 실제 시간 덮어쓰기 (근본 해결)
  //    Claude 추측 시간 대신, 단어가 50%+ 겹치는 실제 세그먼트 구간의 타이밍 사용
  try {
    const normalize = (str) => (str || '')
      .toLowerCase()
      .replace(/[|]/g, ' ')
      .replace(/[^a-z0-9가-힣\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const segNorms = workingSegments.map(s => {
      const ws = normalize(s.text).split(' ').filter(Boolean);
      return { wordsSet: new Set(ws), wordCount: ws.length, start: s.start, end: s.end };
    });

    let matchedCount = 0;
    parsed.sentences.forEach((sent) => {
      const sentWords = normalize(isKorean ? sent.ko : sent.en).split(' ').filter(Boolean);
      if (sentWords.length === 0) return;
      const sentSet = new Set(sentWords);

      let firstSeg = -1, lastSeg = -1;
      for (let si = 0; si < segNorms.length; si++) {
        let overlap = 0;
        segNorms[si].wordsSet.forEach(w => { if (sentSet.has(w)) overlap++; });
        const ratio = overlap / Math.max(1, segNorms[si].wordCount);
        if (ratio >= 0.5) {
          if (firstSeg === -1) firstSeg = si;
          lastSeg = si;
        }
      }

      // 매칭 성공 시에만 덮어씀 (실패 시 기존 Claude 값 유지 = 안전)
      if (firstSeg !== -1 && lastSeg !== -1 && segNorms[lastSeg].end > segNorms[firstSeg].start) {
        sent.start = Math.round(segNorms[firstSeg].start * 10) / 10;
        sent.end   = Math.round((segNorms[lastSeg].end + 0.3) * 10) / 10; // 끝에 0.3초 여유
        matchedCount++;
      }
    });
    console.log('  🎯 rawSegments 시간 매칭: ' + matchedCount + '/' + parsed.sentences.length + ' 문장 보정됨');
  } catch (e) {
    console.log('  ⚠️ 시간 매칭 스킵:', e.message);
  }

  if (isPartial) {
    parsed.note = `Merged from ${segments.length} raw segments into ${parsed.sentences.length} sentences`;
  }

  return parsed;
}
