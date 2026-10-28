const { geminiTools, runTool, findSpots } = require('./tools');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_STEPS = 5;
const DEADLINE_MS = 50000; // vercel.json의 maxDuration(60초)보다 먼저 JSON 오류로 끝내기 위한 한도

// Vercel 대시보드 → Logs 에서 보인다. 키 값은 절대 찍지 않는다.
const log = (...a) => console.log('[chat]', ...a);

const SYSTEM = [
  '너는 제주 여행 추천 도우미다.',
  '사용자의 요청을 보고 필요한 도구를 스스로 골라 호출한다.',
  '- find_spots: 지역(동쪽·서쪽·서귀포·제주시)과 실내/야외 조건으로 장소 목록을 찾는다.',
  '- get_weather: 지역의 현재 날씨와 3일 예보를 가져온다.',
  '날씨가 중요한 요청(비, 더위, 야외 활동 등)이면 get_weather를 먼저 부르고, prefer_indoor 등 결과에 맞춰 find_spots의 indoor를 정한다.',
  '지역을 말하지 않았으면 가장 알맞은 지역을 하나 골라 근거와 함께 말한다.',
  '추천은 find_spots 결과에 있는 장소만 한다. 목록 밖 장소는 없다고 보고 지어내지 않는다. 운영시간·요금은 모른다고 말한다.',
  '답변은 한국어로 짧게: 날씨 한 줄 요약, 추천 장소 3~5곳(이름과 이유)을 말한다.',
].join('\n');

// 생각(thinking) 시간을 줄여 응답을 빠르게 한다. 'off'면 설정을 보내지 않는다.
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low';
let thinkingRejected = false; // 모델이 thinkingLevel을 거부하면 이후 요청에서 뺀다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = [500, 503, 504]; // 일시적인 서버 과부하
const RETRY_WAIT = [1000, 2500]; // 최대 2번 재시도 (함수 제한 시간 30초 안에서)

async function callGemini(contents, startedAt) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const left = DEADLINE_MS - (Date.now() - startedAt);
    if (left < 3000) throw new Error('응답 시간이 너무 오래 걸려 중단했습니다.');
    const res = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(left),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: geminiTools,
        ...(THINKING_LEVEL !== 'off' && !thinkingRejected
          ? { generationConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } }
          : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      log(`Gemini 응답 ${Date.now() - t0}ms`);
      return data;
    }
    if (res.status === 400 && /think/i.test(data.error?.message || '') && !thinkingRejected) {
      thinkingRejected = true;
      log('thinkingLevel 거부됨 — 설정 없이 다시 시도', data.error.message);
      continue;
    }

    log('Gemini 오류', res.status, `시도 ${attempt + 1}`, JSON.stringify(data.error || data));
    if (RETRY_STATUS.includes(res.status) && attempt < RETRY_WAIT.length) {
      await sleep(RETRY_WAIT[attempt]);
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${data.error?.message || '응답 없음'}`);
  }
}

// POST /api/chat  { message: "비 오는 날 동쪽에서 갈 만한 곳" }
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });
  log('요청', { model: MODEL, hasKey: Boolean(process.env.GEMINI_API_KEY), keyLength: (process.env.GEMINI_API_KEY || '').length, env: process.env.VERCEL_ENV });
  if (!process.env.GEMINI_API_KEY) {
    log('GEMINI_API_KEY 없음 — 환경변수를 추가한 뒤 Redeploy 했는지 확인');
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 없습니다.' });
  }
  const message = String(req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

  const startedAt = Date.now();
  const contents = [{ role: 'user', parts: [{ text: message }] }];
  const trace = []; // 어떤 도구를 어떤 입력으로 불렀는지(화면 표시용)
  const found = new Map(); // 지도에 표시할 장소(좌표 포함)
  let weather = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      log(`step ${step + 1}: Gemini 호출`);
      const data = await callGemini(contents, startedAt);
      const content = data.candidates?.[0]?.content;
      if (!content) {
        log('빈 응답', JSON.stringify({ finish: data.candidates?.[0]?.finishReason, feedback: data.promptFeedback }));
        throw new Error(`Gemini가 응답하지 않았습니다. (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '이유 없음'})`);
      }
      contents.push(content); // thought signature 등을 포함해 그대로 되돌려 보낸다.

      const calls = (content.parts || []).filter((p) => p.functionCall);
      if (!calls.length) {
        const answer = content.parts.map((p) => p.text || '').join('').trim();
        const all = [...found.values()];
        const mentioned = all.filter((s) => answer.includes(s.name));
        return res.status(200).json({ answer, spots: mentioned.length ? mentioned : all, weather, trace });
      }

      const responses = [];
      for (const { functionCall: { name, args } } of calls) {
        const output = await runTool(name, args || {});
        log('도구', name, JSON.stringify(args || {}), output.error ? `오류: ${output.error}` : '성공');
        trace.push({ tool: name, input: args || {} });
        if (name === 'find_spots' && !output.error) {
          // 모델에는 좌표 없는 결과를 주고, 지도용 좌표는 따로 모은다.
          for (const s of findSpots(args, { withCoords: true }).spots) found.set(s.name, s);
        }
        if (name === 'get_weather' && !output.error) weather = output;
        responses.push({ functionResponse: { name, response: { result: output } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return res.status(200).json({ answer: '도구 호출이 너무 길어져 중단했습니다. 질문을 더 간단히 해 주세요.', spots: [], weather, trace });
  } catch (e) {
    log('실패', e.stack || e.message);
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return res.status(500).json({ error: timedOut ? '응답 시간이 너무 오래 걸려 중단했습니다.' : e.message, trace });
  }
};
