// SnapTalk Curator - YouTube Shorts 검색 API
// POST /api/search
// Vercel Serverless Function

// 9개 카테고리 × 지역별 검색 키워드 매트릭스
const SEARCH_QUERIES = {
  us: {
    food: ['street food shorts', 'food review shorts english', 'mukbang shorts english', 'cooking shorts english'],
    people: ['street interview shorts', 'asking strangers shorts', 'couples Q&A shorts'],
    home: ['morning routine shorts', 'day in my life shorts', 'pet shorts english'],
    places: ['travel shorts usa', 'hotel tour shorts', 'city tour shorts english'],
    shopping: ['shopping haul shorts', 'costco shorts', 'target haul shorts'],
    fun: ['funny english shorts', 'challenge shorts english', 'reaction shorts english'],
    cars: ['car review shorts', 'unboxing shorts english', 'gadget review shorts'],
    work: ['business english shorts', 'job interview shorts', 'office english shorts'],
    culture: ['american culture shorts english']
  },
  kr: {
    culture: ['kpop shorts english', 'kdrama shorts english', 'kbeauty shorts english', 'hallyu shorts'],
    food: ['korean street food shorts', 'korean mukbang shorts', 'korean cooking shorts'],
    people: ['korean street interview shorts', 'seoul interview shorts'],
    home: ['korean routine shorts', 'seoul daily life shorts'],
    places: ['seoul travel shorts', 'korea travel shorts english', 'jeju travel shorts'],
    shopping: ['korean haul shorts', 'daiso haul shorts', 'seoul shopping shorts'],
    fun: ['korean challenge shorts', 'kpop dance shorts'],
    cars: ['korean car review shorts'],
    work: ['korean business shorts english']
  }
};

// 카테고리별 최소 조회수 기준
const MIN_VIEWS = {
  food: 500000, fun: 500000, culture: 500000,
  people: 200000, places: 200000,
  shopping: 100000, home: 100000, cars: 100000,
  work: 50000
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
  const danger = ['netflix', 'disney', 'pixar', 'warner', 'universal', 'sony pictures', 'tv show', 'movie clip', 'official trailer'];
  const text = (channelTitle + ' ' + description).toLowerCase();
  if (danger.some(kw => text.includes(kw))) return 40;
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
    searchUrl.searchParams.set('videoCaption', 'closedCaption'); // ⭐ 자막 필수!
    searchUrl.searchParams.set('maxResults', '30');
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
        if (v.duration < 10 || v.duration > 90) return false; // 10~90초만
        if (v.viewCount < minViews) return false;
        if (isBlockedContent(v.title, v.description)) return false;
        return true;
      })
      .map(v => ({
        ...v,
        suggestedDifficulty: estimateDifficulty(v.title, v.description),
        educationScore: scoreEducation(v),
        safetyScore: scoreSafety(v.channelTitle, v.description)
      }))
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
