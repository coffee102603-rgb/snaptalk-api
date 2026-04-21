/**
 * SnapTalk v10.10 - AI Real-Time Conversation Partner API
 * 
 * Endpoint: POST /api/chat
 * 
 * Request body:
 *   {
 *     system: string,    // 시스템 프롬프트 (역할/시나리오/표현)
 *     messages: array,   // [{role: 'user'|'assistant', content: string}]
 *     maxTokens: number  // optional, default 100
 *   }
 * 
 * Response:
 *   {
 *     response: string,  // AI 응답 텍스트
 *     usage: object      // 토큰 사용량
 *   }
 */

export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  
  try {
    const { system, messages, maxTokens = 100 } = req.body || {};
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        error: 'messages array required',
        response: "I need a message to respond to!"
      });
    }
    
    /* API Key 체크 */
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[chat] ANTHROPIC_API_KEY not set');
      return res.status(500).json({ 
        error: 'API key not configured',
        response: "I'm not set up yet. Please ask the admin!"
      });
    }
    
    /* Anthropic SDK 로드 */
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    /* Claude API 호출 (Sonnet 4.5 - 빠르고 정확) */
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: Math.min(maxTokens, 200),  /* 대화는 짧게! */
      system: system || 'You are a friendly English conversation partner for Korean learners. Keep responses short (1-2 sentences, under 15 words) and encouraging.',
      messages: messages
    });
    
    /* 응답 텍스트 추출 */
    const text = response.content && response.content[0] && response.content[0].text
      ? response.content[0].text.trim()
      : "That's interesting! Tell me more.";
    
    console.log('[chat] Response generated:', text.substring(0, 50) + '...');
    
    return res.status(200).json({
      response: text,
      usage: response.usage || {}
    });
    
  } catch (error) {
    console.error('[chat API error]', error);
    return res.status(500).json({
      error: error.message,
      response: "Sorry, I'm having trouble connecting. Let's try again!"
    });
  }
}
