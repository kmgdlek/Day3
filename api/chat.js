const { geminiTools, runTool, findSpots } = require('./tools');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_STEPS = 5;

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

async function callGemini(contents) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: geminiTools,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
  return data;
}

// POST /api/chat  { message: "비 오는 날 동쪽에서 갈 만한 곳" }
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 없습니다.' });
  }
  const message = String(req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

  const contents = [{ role: 'user', parts: [{ text: message }] }];
  const trace = []; // 어떤 도구를 어떤 입력으로 불렀는지(화면 표시용)
  const found = new Map(); // 지도에 표시할 장소(좌표 포함)
  let weather = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callGemini(contents);
      const content = data.candidates?.[0]?.content;
      if (!content) throw new Error('Gemini가 응답하지 않았습니다.');
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
    return res.status(500).json({ error: e.message });
  }
};
