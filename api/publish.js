// ============================================================
// SnapTalk API · /api/publish (v1.0) — 공개 엔드포인트 🎉
// ============================================================
// 작동 순서:
//   1. videoId 받기
//   2. CURATOR_SECRET 인증 체크
//   3. GitHub에서 snaptalk-youtube-lab.html 가져오기
//   4. 해당 영상의 status:"review" → "live" 변경
//   5. GitHub에 커밋 & push
//   → 2-3분 후 모든 사용자에게 공개!
//
// 환경변수:
//   - GITHUB_TOKEN (필수)
//   - CURATOR_SECRET (필수)
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

  // 인증 체크 (upload.js와 동일한 시크릿 사용)
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
    const { videoId } = req.body || {};
    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({ error: 'videoId is required (string)' });
    }

    console.log(`🎉 Publishing video: ${videoId}`);

    // ========================================
    // STEP 1: 현재 HTML 가져오기
    // ========================================
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const getRes = await fetch(getUrl, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnapTalk-Publish-API',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!getRes.ok) {
      const errText = await getRes.text();
      throw new Error(`GitHub GET failed (${getRes.status}): ${errText.slice(0, 200)}`);
    }

    const fileData = await getRes.json();
    const sha = fileData.sha;
    const html = Buffer.from(fileData.content, 'base64').toString('utf8');

    console.log(`  ✅ Fetched HTML: ${html.length} chars, SHA: ${sha.slice(0, 8)}`);

    // ========================================
    // STEP 2: 해당 영상 찾기
    // upload.js가 JSON.stringify로 삽입 → "id":"XXX" 형식
    // 기존 영상은 id:'XXX' 형식 (status 없음)
    // ========================================
    const jsonIdPattern = `"id":"${videoId}"`;
    const litIdPattern = `id:'${videoId}'`;

    let idIdx = html.indexOf(jsonIdPattern);
    let isJsonFormat = true;

    if (idIdx === -1) {
      idIdx = html.indexOf(litIdPattern);
      isJsonFormat = false;
    }

    if (idIdx === -1) {
      return res.status(404).json({
        error: `Video not found: ${videoId}`,
        hint: '업로드된 영상 목록에서 확인해주세요.'
      });
    }

    // ========================================
    // STEP 3: status:"review" → "live" 변경
    // 같은 객체 내에서만 (다른 객체의 status 건드리면 안 됨)
    // ========================================
    let updatedHtml;
    let foundStatus = false;

    if (isJsonFormat) {
      const reviewPattern = '"status":"review"';
      const statusIdx = html.indexOf(reviewPattern, idIdx);

      if (statusIdx !== -1) {
        // 같은 객체 내인지 확인: id와 status 사이에 } 없어야 함
        const between = html.slice(idIdx, statusIdx);
        if (!between.includes('}')) {
          updatedHtml = 
            html.slice(0, statusIdx) + 
            '"status":"live"' + 
            html.slice(statusIdx + reviewPattern.length);
          foundStatus = true;
        }
      }
    } else {
      // 기존 영상 (JS 리터럴 형식)에 status가 있다면
      const reviewPattern = `status:'review'`;
      const statusIdx = html.indexOf(reviewPattern, idIdx);

      if (statusIdx !== -1) {
        const between = html.slice(idIdx, statusIdx);
        if (!between.includes('}')) {
          updatedHtml = 
            html.slice(0, statusIdx) + 
            `status:'live'` + 
            html.slice(statusIdx + reviewPattern.length);
          foundStatus = true;
        }
      }
    }

    if (!foundStatus) {
      return res.status(409).json({
        error: 'Video does not have "review" status',
        hint: '이미 공개된 영상이거나, 상태가 다릅니다.',
        videoId
      });
    }

    console.log(`  ✅ Status changed: review → live (diff: ${updatedHtml.length - html.length} chars)`);

    // ========================================
    // STEP 4: GitHub에 커밋
    // ========================================
    const newContent = Buffer.from(updatedHtml, 'utf8').toString('base64');
    const commitMsg = `feat: publish video ${videoId} (review → live)`;

    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnapTalk-Publish-API',
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

    console.log(`🎉 Published in ${elapsed}s — commit: ${putData.commit?.sha?.slice(0, 8)}`);

    res.status(200).json({
      success: true,
      videoId,
      newStatus: 'live',
      commit: {
        sha: putData.commit?.sha,
        message: commitMsg,
        url: putData.commit?.html_url
      },
      elapsed: elapsed + 's',
      message: '✅ 공개 완료! 2~3분 후 모든 사용자에게 보입니다.'
    });

  } catch (err) {
    console.error('❌ Publish error:', err);
    res.status(500).json({
      error: err.message || 'Internal server error',
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
    });
  }
}
