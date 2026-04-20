// ============================================================
// SnapTalk API · /api/upload (v1.0) — 자동 업로드 엔드포인트 🚀
// ============================================================
// 작동 순서:
//   1. Curator에서 영상 JSON 받기
//   2. GitHub API로 snaptalk-youtube-lab.html 현재 내용 가져오기
//   3. 중복 체크 (같은 videoId 있으면 거절)
//   4. SHORTS 배열에 새 영상 삽입 (status:"review" 유지!)
//   5. GitHub에 커밋 & push
//   → 2-3분 후 GitHub Pages 자동 배포
//   → 관리자 모드(?admin=1)에서만 "🔒 비공개" 영상으로 표시
//
// 환경변수:
//   - GITHUB_TOKEN (필수)
//   - CURATOR_SECRET (필수, Curator 인증용)
// ============================================================

const OWNER = 'coffee102603-rgb';
const REPO = 'snaptalk';
const FILE_PATH = 'snaptalk-youtube-lab.html';
const BRANCH = 'main';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Curator-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 인증 체크
  const secret = req.headers['x-curator-secret'];
  if (!process.env.CURATOR_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured: CURATOR_SECRET missing' });
  }
  if (secret !== process.env.CURATOR_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'Server misconfigured: GITHUB_TOKEN missing' });
  }

  const startTime = Date.now();

  try {
    const {
      id,
      title,
      cat,
      catIcon,
      diff,
      region,
      sentences,
      dubs,
      duration,
      tags,
      status,
      createdAt,
      curatedBy
    } = req.body || {};

    // 필수 필드 검증
    if (!id || !title || !sentences || !Array.isArray(sentences) || sentences.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['id', 'title', 'sentences (array)']
      });
    }

    // ========================================
    // v2.5 호환: translations.ko.text → ko 루트 필드로 평탄화
    // ========================================
    // Curator/API가 주는 구조:   {en, translations:{ko:{text,highlight}}}
    // 메인 앱이 읽는 구조:        {en, ko, koHighlight}
    // → 메인 앱 호환을 위해 평탄화!
    const normalizedSentences = sentences.map(s => {
      const normalized = { ...s };
      if (s.translations?.ko) {
        if (s.translations.ko.text && !normalized.ko) {
          normalized.ko = s.translations.ko.text;
        }
        if (s.translations.ko.highlight && !normalized.koHighlight) {
          normalized.koHighlight = s.translations.ko.highlight;
        }
      }
      // translations 필드는 유지 (나중에 다국어 확장 대비)
      return normalized;
    });

    console.log(`🚀 Uploading video: ${id} - ${title}`);
    console.log(`  ✅ Normalized ${normalizedSentences.length} sentences (ko field populated)`);

    // ========================================
    // STEP 1: 현재 HTML 가져오기
    // ========================================
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const getRes = await fetch(getUrl, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnapTalk-Upload-API',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('GET failed:', errText);
      throw new Error(`GitHub GET failed (${getRes.status}): ${errText.slice(0, 200)}`);
    }

    const fileData = await getRes.json();
    const sha = fileData.sha;
    const html = Buffer.from(fileData.content, 'base64').toString('utf8');

    console.log(`  ✅ Fetched HTML: ${html.length} chars, SHA: ${sha.slice(0, 8)}`);

    // ========================================
    // STEP 2: 중복 체크
    // ========================================
    // id가 SHORTS 배열에 이미 있으면 거절 (작은따옴표 or 큰따옴표 둘 다 체크)
    if (html.includes(`id:'${id}'`) || html.includes(`"id":"${id}"`) || html.includes(`id: "${id}"`)) {
      return res.status(409).json({
        error: 'Video already exists',
        videoId: id,
        hint: '이미 업로드된 영상입니다.'
      });
    }

    // ========================================
    // STEP 3: 새 영상 데이터 구성
    // ========================================
    const newVideo = {
      id,
      title,
      status: status || 'review',  // 중요: 기본값 review
      cat: cat || 'food',
      catIcon: catIcon || '🎬',
      diff: diff || 'intermediate',
      dubs: dubs || 0,
      sentences: normalizedSentences
    };

    // 선택적 필드 추가 (있는 경우에만)
    if (duration) newVideo.duration = duration;
    if (tags) newVideo.tags = tags;
    if (createdAt) newVideo.createdAt = createdAt;
    if (curatedBy) newVideo.curatedBy = curatedBy;

    // JSON.stringify로 만든 건 JS에서도 유효한 객체 리터럴
    const newVideoJson = JSON.stringify(newVideo);

    // ========================================
    // STEP 4: HTML 수정 (SHORTS 배열에 삽입)
    // ========================================
    const targetRegion = region === 'kr' ? 'kr' : 'us';
    let updatedHtml;

    if (targetRegion === 'us') {
      // us 배열 끝 = '],kr:[' 바로 앞
      const marker = '],kr:[';
      const idx = html.indexOf(marker);
      if (idx === -1) {
        throw new Error('SHORTS structure not found: "],kr:[" marker missing');
      }
      // 삽입할 문자열: 콤마 + 새 영상
      const insertion = `,\n  ${newVideoJson}\n`;
      updatedHtml = html.slice(0, idx) + insertion + html.slice(idx);
    } else {
      // kr 배열 끝 = ']};' 바로 앞 (kr:[ 다음에 오는 ]})
      const krStart = html.indexOf('kr:[');
      if (krStart === -1) throw new Error('kr: array not found');
      const closeIdx = html.indexOf(']};', krStart);
      if (closeIdx === -1) throw new Error('kr closing bracket ]}; not found');

      // kr 배열이 비어있는지 (kr:[] 또는 kr:[\n]) 체크해서 콤마 처리
      const krSegment = html.slice(krStart + 4, closeIdx).trim();
      const needsComma = krSegment.length > 0;
      const insertion = (needsComma ? ',' : '') + `\n  ${newVideoJson}\n`;
      updatedHtml = html.slice(0, closeIdx) + insertion + html.slice(closeIdx);
    }

    console.log(`  ✅ HTML updated: +${updatedHtml.length - html.length} chars`);

    // ========================================
    // STEP 5: GitHub에 커밋
    // ========================================
    const newContent = Buffer.from(updatedHtml, 'utf8').toString('base64');
    const commitMsg = `feat: add "${title}" (${targetRegion}, status: review) via Curator`;

    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnapTalk-Upload-API',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        message: commitMsg,
        content: newContent,
        sha,
        branch: BRANCH
      })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('PUT failed:', errText);
      throw new Error(`GitHub PUT failed (${putRes.status}): ${errText.slice(0, 300)}`);
    }

    const putData = await putRes.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`🎉 Upload success in ${elapsed}s — commit: ${putData.commit?.sha?.slice(0, 8)}`);

    res.status(200).json({
      success: true,
      videoId: id,
      title,
      region: targetRegion,
      status: 'review',
      commit: {
        sha: putData.commit?.sha,
        message: commitMsg,
        url: putData.commit?.html_url
      },
      elapsed: elapsed + 's',
      message: '✅ 비공개 상태로 업로드 완료! 2~3분 후 관리자 모드에서 확인하세요.',
      adminUrl: `https://coffee102603-rgb.github.io/snaptalk/snaptalk-youtube-lab.html?admin=1`
    });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({
      error: err.message || 'Internal server error',
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
    });
  }
}
