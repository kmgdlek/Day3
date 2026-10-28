const { geminiTools, runTool, findSpots, getWeather, spots, locate, AREAS } = require('./tools');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
// single(기본): 날씨·장소를 서버가 미리 모아 Gemini를 한 번만 호출. agent: Gemini가 도구를 직접 골라 여러 번 호출.
const MODE = process.env.CHAT_MODE === 'agent' ? 'agent' : 'single';
const MAX_STEPS = 5;
const DEADLINE_MS = 50000; // vercel.json의 maxDuration(60초)보다 먼저 JSON 오류로 끝내기 위한 한도
// 생각(thinking)을 짧게: flash-lite는 기본이 minimal이라 설정을 보내지 않는다. 다른 모델이면 'low' 등을 환경변수로 지정.
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'off';

// Vercel 대시보드 → Logs 에서 보인다. 키 값은 절대 찍지 않는다.
const log = (...a) => console.log('[chat]', ...a);

const RULES = [
  '너는 제주 여행 추천 도우미다.',
  '추천은 주어진/조회된 장소 목록에 있는 장소만 한다. 목록 밖 장소는 없다고 보고 지어내지 않는다. 운영시간·요금은 모른다고 말한다.',
  '지역을 말하지 않았으면 날씨와 요청에 가장 알맞은 지역을 하나 골라 근거와 함께 말한다.',
  '답변은 한국어로 짧게: 날씨 한 줄 요약, 추천 장소 3~5곳(이름과 이유).',
];

const AGENT_SYSTEM = [
  ...RULES,
  '사용자의 요청을 보고 필요한 도구를 스스로 골라 호출한다.',
  '- find_spots: 지역(동쪽·서쪽·서귀포·제주시)과 실내/야외 조건으로 장소 목록을 찾는다.',
  '- get_weather: 지역의 현재 날씨와 3일 예보를 가져온다.',
  '날씨가 중요한 요청이면 get_weather를 먼저 부르고, prefer_indoor 등 결과에 맞춰 find_spots의 indoor를 정한다.',
].join('\n');

const SINGLE_SYSTEM = [
  '제주 여행 추천 도우미. 한국어로 아주 짧게 답한다: 날씨 한 줄, 추천 3곳(이유 한 문장씩).',
  '아래 날씨와 장소 목록 안에서만 고르고, 목록 밖 장소는 없다고 본다. *는 실내.',
  '추천 장소 이름은 목록 그대로 [[이름]] 으로 감싼다(*는 빼고). 비가 오거나 강수확률이 높으면 실내를 우선한다.',
  '지역 말이 없으면 알맞은 지역 하나를 골라 이유를 말한다. 운영시간·요금은 모른다고 한다.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = [500, 503, 504]; // 일시적인 서버 과부하
const RETRY_WAIT = [1000, 2500]; // 최대 2번 재시도
let thinkingRejected = false; // 모델이 thinkingLevel을 거부하면 이후 요청에서 뺀다.

async function callGemini({ system, contents, withTools }, startedAt) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const left = DEADLINE_MS - (t0 - startedAt);
    if (left < 3000) throw new Error('응답 시간이 너무 오래 걸려 중단했습니다.');
    const res = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(left),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        ...(withTools ? { tools: geminiTools } : {}),
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
    log('Gemini 오류', res.status, `시도 ${attempt + 1}`, `${Date.now() - t0}ms`, JSON.stringify(data.error || data));
    if (RETRY_STATUS.includes(res.status) && attempt < RETRY_WAIT.length) {
      await sleep(RETRY_WAIT[attempt]);
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${data.error?.message || '응답 없음'}`);
  }
}

// ---- single: 도구는 서버가 미리 실행하고, Gemini는 한 번만 호출 ----
// 질문에 지역 단서가 있으면 그 지역만 보내 입력을 줄인다. 없으면 전체.
const AREA_WORDS = {
  동쪽: ['동쪽', '성산', '구좌', '일출봉', '섭지', '세화', '월정'],
  서쪽: ['서쪽', '한림', '안덕', '협재', '산방', '용머리', '금능'],
  서귀포: ['서귀포', '중문', '남원', '표선', '대정', '마라도', '가파도', '쇠소깍', '남쪽'],
  제주시: ['제주시', '애월', '함덕', '조천', '우도', '추자', '한경', '공항', '북쪽'],
};
const inArea = (spot, area) => spot.area === area || spot.area.startsWith(area + '(');

async function runSingle(message, startedAt) {
  const hit = AREAS.filter((a) => AREA_WORDS[a].some((w) => message.includes(w)));
  const wanted = hit.length ? hit : AREAS;

  const weatherList = await Promise.all(wanted.map((area) => getWeather({ area })));
  log('날씨 조회', wanted.join(','), weatherList.map((w) => (w.error ? 'X' : 'O')).join(''));

  const weatherText = weatherList
    .map((w) =>
      w.error
        ? `${w.area || '?'}: 조회 실패`
        : `${w.area}: 지금 ${w.now.weather} ${w.now.temperature}°C, 오늘 강수 ${w.forecast[0].rain_probability}%, ` +
          `내일 ${w.forecast[1].weather} 강수 ${w.forecast[1].rain_probability}%, 실내 우선: ${w.prefer_indoor ? '예' : '아니오'}`
    )
    .join('\n');

  // 이름만 지역별로 한 줄에 묶고, 실내는 * 로 표시한다(유형은 보내지 않는다).
  const spotText = wanted
    .map((a) => {
      const list = spots.filter((s) => inArea(s, a));
      return `${a}: ` + list.map((s) => s.name + (s.indoor ? '*' : '')).join(', ');
    })
    .join('\n');

  const prompt = `날씨\n${weatherText}\n\n장소(*=실내)\n${spotText}\n\n요청: ${message}`;
  const data = await callGemini({ system: SINGLE_SYSTEM, contents: [{ role: 'user', parts: [{ text: prompt }] }] }, startedAt);

  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!raw) {
    throw new Error(`Gemini가 응답하지 않았습니다. (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '이유 없음'})`);
  }
  const byName = new Map(spots.map((s) => [s.name, s]));
  const picked = [];
  raw.replace(/\[\[(.+?)\]\]/g, (_, name) => {
    const s = byName.get(name.trim());
    if (s && !picked.includes(s)) picked.push(s);
  });
  const answer = raw.replace(/\[\[(.+?)\]\]/g, '$1');
  const area = picked[0] && AREAS.find((a) => picked[0].area === a || picked[0].area.startsWith(a + '('));
  return {
    answer,
    spots: picked.map((s) => ({ name: s.name, areas: [s.area], indoor: s.indoor, description: s.type, ...locate(s) })),
    weather: weatherList.find((w) => w.area === area) || null,
    trace: [{ tool: 'get_weather', input: { area: '전체' } }, { tool: 'find_spots', input: { area: '전체' } }],
  };
}

// ---- agent: Gemini가 도구를 직접 골라 여러 번 호출 ----
async function runAgent(message, startedAt) {
  const contents = [{ role: 'user', parts: [{ text: message }] }];
  const trace = [];
  const found = new Map();
  let weather = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    log(`step ${step + 1}: Gemini 호출`);
    const data = await callGemini({ system: AGENT_SYSTEM, contents, withTools: true }, startedAt);
    const content = data.candidates?.[0]?.content;
    if (!content) {
      throw new Error(`Gemini가 응답하지 않았습니다. (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '이유 없음'})`);
    }
    contents.push(content); // thought signature 등을 포함해 그대로 되돌려 보낸다.

    const calls = (content.parts || []).filter((p) => p.functionCall);
    if (!calls.length) {
      const answer = content.parts.map((p) => p.text || '').join('').trim();
      const all = [...found.values()];
      const mentioned = all.filter((s) => answer.includes(s.name));
      return { answer, spots: mentioned.length ? mentioned : all, weather, trace };
    }

    const responses = [];
    for (const { functionCall: { name, args } } of calls) {
      const output = await runTool(name, args || {});
      log('도구', name, JSON.stringify(args || {}), output.error ? `오류: ${output.error}` : '성공');
      trace.push({ tool: name, input: args || {} });
      if (name === 'find_spots' && !output.error) {
        for (const s of findSpots(args, { withCoords: true }).spots) found.set(s.name, s);
      }
      if (name === 'get_weather' && !output.error) weather = output;
      responses.push({ functionResponse: { name, response: { result: output } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { answer: '도구 호출이 너무 길어져 중단했습니다. 질문을 더 간단히 해 주세요.', spots: [], weather, trace };
}

// POST /api/chat  { message: "비 오는 날 동쪽에서 갈 만한 곳" }
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });
  log('요청', { mode: MODE, model: MODEL, hasKey: Boolean(process.env.GEMINI_API_KEY), env: process.env.VERCEL_ENV });
  if (!process.env.GEMINI_API_KEY) {
    log('GEMINI_API_KEY 없음 — 환경변수를 추가한 뒤 Redeploy 했는지 확인');
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 없습니다.' });
  }
  const message = String(req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

  const startedAt = Date.now();
  try {
    const result = MODE === 'agent' ? await runAgent(message, startedAt) : await runSingle(message, startedAt);
    log(`완료 ${Date.now() - startedAt}ms`);
    return res.status(200).json(result);
  } catch (e) {
    log('실패', e.stack || e.message);
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return res.status(500).json({ error: timedOut ? '응답 시간이 너무 오래 걸려 중단했습니다.' : e.message });
  }
};
