# SnapTalk API v2.0 🚀

YouTube Shorts → 학습용 레슨 자동 생성 API

## 🆕 v2.0 업데이트

**Whisper 통합!** 이제 자막이 없는 영상도 작동합니다.

### 작동 순서
1. **수동 자막 시도** (무료, 빠름) → 있으면 사용
2. **Whisper API 자동 생성** (있든 없든 항상 작동!) → 없으면 자동 전환
3. **Claude 번역 + 교육자료화**

### 비용 (영상 1개당)
- 수동 자막: **0원** (YouTube 공식 API)
- Whisper: **~10원** (Shorts는 1분 이하)
- Claude: **~12원** (번역 + 학습자료)
- **총: 수동=12원 / Whisper=22원**

## 📡 API 엔드포인트

### POST /api/generate

**요청:**
```json
{
  "videoUrl": "https://www.youtube.com/shorts/VIDEO_ID"
}
```

**응답 (성공):**
```json
{
  "source": "manual",  // 또는 "whisper"
  "segmentsCount": 5,
  "elapsed": "3.2s",
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
}
```

## 🔧 환경 변수 (Vercel)

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## 🧪 테스트

```bash
curl -X POST https://snaptalk-api-two.vercel.app/api/generate \
  -H "Content-Type: application/json" \
  -d '{"videoUrl": "https://www.youtube.com/shorts/ikYVBHLSOpY"}'
```

## 📚 기술 스택

- **@anthropic-ai/sdk** - Claude (번역)
- **openai** - Whisper (자막 생성)
- **@distube/ytdl-core** - YouTube 오디오 다운로드
- **Vercel Serverless** - 60초 실행 시간

## ⚠️ 제한 사항

- Vercel Hobby: 60초/요청
- Whisper API: 25MB/파일
- YouTube Shorts: 최대 60초 (대부분 OK)

## 🐛 트러블슈팅

### "OPENAI_API_KEY not configured"
→ Vercel 환경 변수 추가 필요

### "Audio too large"
→ 60초 넘는 영상은 실패할 수 있음

### "ytdl 차단"
→ `@distube/ytdl-core` 최신 버전으로 업데이트
