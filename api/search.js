// SnapTalk Curator - YouTube Shorts 검색 API
// POST /api/search
// Vercel Serverless Function

// 9개 카테고리 × 지역별 검색 키워드 매트릭스
const SEARCH_QUERIES = {
  us: {
    food: ['what i eat in a day usa', 'american food review vlog', 'cooking vlog american', 'street food vlog usa', 'korean food foreigner english', 'trying korean food english', 'korean street food english'],
    people: ['american vlog talking', 'storytime shorts american', 'american explains', 'day in my life student usa', 'get ready with me american', 'english conversation usa'],
    home: ['day in my life usa', 'day in my life new york', 'american apartment tour', 'grocery shopping vlog usa', 'american morning routine', 'living in america vlog'],
    places: ['tokyo travel vlog', 'japan travel vlog english', 'paris walking tour', 'italy travel vlog english', 'europe travel vlog english', 'american traveling abroad', 'new york walking tour', 'los angeles travel vlog', 'korea travel vlog english', 'seoul travel english', 'visiting korea english'],
    shopping: ['american shopping haul', 'costco haul vlog', 'target haul shorts', 'what i bought haul usa', 'amazon must haves usa'],
    fun: ['english idioms explained', 'american slang explained', 'english expressions explained', 'common english mistakes'],
    cars: ['product review vlog usa', 'tech review vlog american', 'what is in my bag usa'],
    work: ['job interview english conversation', 'business english conversation', 'english role play office', 'self introduction english', 'english phrases for work'],
    culture: ['life in america vlog', 'american culture explained', 'moving to america vlog'],
    travel_english: ['english at the airport', 'hotel check in english', 'restaurant english ordering', 'ordering coffee in english', 'asking for directions english', 'english at the bank', 'doctor appointment english', 'pharmacy english conversation', 'renting apartment english', 'airport immigration english', 'taxi english conversation', 'subway directions english', 'english role play conversation', 'real life english conversation', 'english conversation for travelers']
  },

  kr: {
    // 한국인이 한국어로 말하는 영상 위주 (외국인 영어 소개 X)
    food: ['한국 먹방 쇼츠', '먹방 브이로그', '집밥 레시피 쇼츠', '편의점 먹방', '길거리 음식 먹방', '자취 요리 쇼츠', '백종원 레시피', '한식 만들기 쇼츠'],
    people: ['길거리 인터뷰 한국', '서울 길거리 인터뷰', 'MZ 인터뷰', '대학생 브이로그', '직장인 브이로그 한국', '연애 토크 쇼츠'],
    home: ['자취 브이로그', '하루 일과 브이로그', '아침 루틴 브이로그', '직장인 브이로그', '원룸 자취 브이로그', '주부 일상 브이로그'],
    places: ['서울 여행 브이로그', '제주도 여행 브이로그', '부산 여행 브이로그', '서울 가볼만한곳 쇼츠', '국내여행 브이로그', '한국 명소 쇼츠'],
    shopping: ['다이소 추천템', '올리브영 하울', '편의점 신상 리뷰', '쿠팡 추천', '쇼핑 하울 브이로그', '장보기 브이로그'],
    fun: ['한국 챌린지', '커플 챌린지 쇼츠', '웃긴 영상 한국', 'K팝 커버댄스', '댄스 챌린지'],
    cars: ['신차 리뷰 한국', '자동차 리뷰 쇼츠', '국산차 리뷰'],
    work: ['직장인 브이로그', '신입사원 브이로그', '퇴사 브이로그', '면접 꿀팁'],
    culture: ['kpop 안무 거울모드', '아이돌 직캠 자막', '케이팝 커버댄스 쇼츠', '드라마 명장면 모음', '예능 레전드 자막', '아이돌 브이로그', '한복 입어보기 브이로그', '케이팝 챌린지'],
    travel_english: ['식당 주문 꿀팁 브이로그', '카페에서 주문하기 브이로그', '한국 지하철 타는법', '택시 타기 브이로그', '편의점에서 쇼츠', '한국 여행 꿀팁 쇼츠', '관광지 브이로그', '한국 길거리 브이로그']
  }
};

// 카테고리별 최소 조회수 기준
const MIN_VIEWS = {
  food: 10000, fun: 10000, culture: 10000,
  people: 10000, places: 10000,
  shopping: 10000, home: 10000, cars: 10000,
  work: 10000, travel_english: 10000
};

// ISO 8601 duration (PT1M15S) → 초 변환
function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const m = parseInt(match[1] || '0', 10);
  const s = parseInt(match[2] || '0', 10);
  return m * 60 + s;
}

// 부적절한 키워드 필터
const BLOCKED_KEYWORDS = [
  'fuck', 'shit', 'bitch', 'nsfw', '18+', 'xxx',
  'nude', 'sex', 'porn', 'adult only'
];

function isBlockedContent(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  return BLOCKED_KEYWORDS.some(kw => text.includes(kw));
}

// 난이도 자동 추정 (제목+설명 길이 기반)
function estimateDifficulty(title, description) {
  const words = (title + ' ' + description).split(/\s+/).filter(Boolean);
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / Math.max(words.length, 1);
  if (avgLen < 5) return 'easy';
  if (avgLen < 7) return 'mid';
  return 'hard';
}

// 교육 적합성 점수 (0~100)
function scoreEducation(video) {
  let score = 50;
  const title = video.title.toLowerCase();
  const desc = (video.description || '').toLowerCase();
  
  // 대화/학습 관련 키워드 → 가점
  const edKeywords = ['interview', 'review', 'how', 'why', 'what', 'tour', 'routine', 'day', 'try', 'learn', 'english', 'korean'];
  edKeywords.forEach(kw => {
    if (title.includes(kw) || desc.includes(kw)) score += 5;
  });
  
  // 조회수 보너스
  if (video.viewCount > 1000000) score += 15;
  else if (video.viewCount > 500000) score += 10;
  else if (video.viewCount > 100000) score += 5;
  
  // 좋아요 비율 (좋아요/조회수 > 5% 면 우수)
  const likeRatio = (video.likeCount || 0) / Math.max(video.viewCount, 1);
  if (likeRatio > 0.05) score += 10;
  
  return Math.min(100, Math.max(0, score));
}

// 저작권 안전도 (공식 채널일수록 위험, 개인 크리에이터 안전)
function scoreSafety(channelTitle, description) {
  const danger = [
    // 글로벌 방송/영화사
    'netflix', 'disney', 'pixar', 'warner', 'universal', 'sony pictures',
    'paramount', 'hbo', 'marvel', 'dreamworks',
    'tv show', 'movie clip', 'official trailer', 'full episode', 'official mv',
    'music video', 'official video', 'lyrics video',
    // 한국 방송사/기획사 (드라마/예능/K-pop MV 저작권)
    'kbs', 'mbc', 'sbs', 'tvn', 'jtbc', 'ocn', 'ena',
    'hybe', 'sm entertainment', 'jyp', 'yg entertainment', 'starship',
    '드라마', '예능', '뮤직비디오', '공식 영상', '하이라이트',
    '본방', '재방송', '풀버전', 'mv', 'official', '방송분'
  ];
  const text = (channelTitle + ' ' + description).toLowerCase();
  if (danger.some(kw => text.includes(kw))) return 5;  // 저작권 위험 = 강한 감점
  return 90;
}

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Curator-Secret');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 🔒 시크릿 인증
  const secret = req.headers['x-curator-secret'];
  if (!secret || secret !== process.env.CURATOR_SECRET) {
    return res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'Missing or invalid curator secret' 
    });
  }

  // 환경변수 체크
  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ 
      error: 'Server misconfigured', 
      message: 'YOUTUBE_API_KEY not set in environment variables' 
    });
  }

  try {
    const { 
      category = 'food', 
      region = 'us', 
      maxResults = 15 
    } = req.body || {};

    // 1. 검색 키워드 선택
    const queryList = SEARCH_QUERIES[region]?.[category];
    if (!queryList || queryList.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid category or region',
        available: { regions: Object.keys(SEARCH_QUERIES), categories: Object.keys(SEARCH_QUERIES[region] || {}) }
      });
    }
    const query = queryList[Math.floor(Math.random() * queryList.length)];

    // 2. YouTube Search API 호출 (영상 ID만 먼저 얻음)
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('videoDuration', 'short'); // ~4분 이하
    // 자막 제약: 미국(영어)은 자막 필수, 한국은 완화 (한국어 영상은 자막 적음)
    if (region !== 'kr') {
      searchUrl.searchParams.set('videoCaption', 'closedCaption');
    } // ⭐ 자막 있는 영상만!
    searchUrl.searchParams.set('maxResults', '50');
    searchUrl.searchParams.set('order', 'viewCount');
    searchUrl.searchParams.set('regionCode', region === 'kr' ? 'KR' : 'US');
    searchUrl.searchParams.set('relevanceLanguage', region === 'kr' ? 'ko' : 'en');
    searchUrl.searchParams.set('key', process.env.YOUTUBE_API_KEY);

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    
    if (searchData.error) {
      console.error('YouTube Search API error:', searchData.error);
      return res.status(500).json({ 
        error: 'YouTube API error', 
        detail: searchData.error.message,
        hint: searchData.error.message.includes('quota') ? 'Daily quota exceeded. Try tomorrow.' : undefined
      });
    }

    if (!searchData.items || searchData.items.length === 0) {
      return res.status(200).json({ 
        success: true, 
        category, 
        region, 
        query, 
        totalFound: 0, 
        videos: [] 
      });
    }

    const videoIds = searchData.items.map(item => item.id.videoId).filter(Boolean).join(',');

    // 3. Videos API 호출 (조회수, 길이, 좋아요 등 상세 정보)
    const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videosUrl.searchParams.set('part', 'snippet,contentDetails,statistics');
    videosUrl.searchParams.set('id', videoIds);
    videosUrl.searchParams.set('key', process.env.YOUTUBE_API_KEY);

    const videosRes = await fetch(videosUrl);
    const videosData = await videosRes.json();

    if (videosData.error) {
      console.error('YouTube Videos API error:', videosData.error);
      return res.status(500).json({ error: 'YouTube API error', detail: videosData.error.message });
    }

    // 4. 필터링 + 점수 계산
    const minViews = MIN_VIEWS[category] || 100000;
    
    const filtered = (videosData.items || [])
      .map(item => {
        const duration = parseDuration(item.contentDetails.duration);
        const viewCount = parseInt(item.statistics.viewCount || '0', 10);
        const likeCount = parseInt(item.statistics.likeCount || '0', 10);
        
        return {
          videoId: item.id,
          title: item.snippet.title,
          description: (item.snippet.description || '').slice(0, 200),
          channelTitle: item.snippet.channelTitle,
          channelId: item.snippet.channelId,
          publishedAt: item.snippet.publishedAt,
          duration,
          viewCount,
          likeCount,
          thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium?.url,
          hasCaption: item.contentDetails.caption === 'true',
          language: item.snippet.defaultLanguage || item.snippet.defaultAudioLanguage || 'unknown'
        };
      })
      .filter(v => {
        if (v.duration < 8 || v.duration > 180) return false; // 10~90초만
        if (v.viewCount < minViews) return false;
        if (isBlockedContent(v.title, v.description)) return false;
        // 🇰🇷 한국 모드: 제목에 한글이 거의 없으면 외국인 영어 영상 → 제외
        if (region === 'kr') {
          const koreanChars = (v.title.match(/[가-힣]/g) || []).length;
          const titleLen = v.title.replace(/\s/g, '').length || 1;
          const koreanRatio = koreanChars / titleLen;
          // 제목의 한글 비율이 25% 미만이면 외국인/영어 영상으로 간주
          if (koreanRatio < 0.25) return false;
        }
        return true;
      })
      .map(v => ({
        ...v,
        suggestedDifficulty: estimateDifficulty(v.title, v.description),
        educationScore: scoreEducation(v),
        safetyScore: scoreSafety(v.channelTitle, v.description)
      }))
      .filter(v => v.safetyScore >= 50)  // ⚖️ 저작권 위험(방송/영화/MV) 영상 제외
      .sort((a, b) => {
        // 종합 점수순 정렬: 교육점수 + 안전점수 + 조회수 보너스
        const scoreA = a.educationScore + a.safetyScore + Math.log10(a.viewCount + 1) * 5;
        const scoreB = b.educationScore + b.safetyScore + Math.log10(b.viewCount + 1) * 5;
        return scoreB - scoreA;
      })
      .slice(0, maxResults);

    return res.status(200).json({
      success: true,
      category,
      region,
      query,
      searchedAt: new Date().toISOString(),
      totalFound: videosData.items.length,
      filtered: filtered.length,
      videos: filtered
    });

  } catch (err) {
    console.error('Search API error:', err);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: err.message 
    });
  }
}
