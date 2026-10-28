const { spots } = require('../jeju_spots.json');
const { coords, area_centers } = require('../jeju_coords.json');

const AREAS = ['동쪽', '서쪽', '서귀포', '제주시'];
const MAX_RESULTS = 8;

// 지도용 좌표. 좌표가 없는 장소는 지역 중심 근처(이름 기반 고정 오프셋)에 두고 approx로 표시한다.
function locate(spot) {
  if (coords[spot.name]) return { lat: coords[spot.name][0], lng: coords[spot.name][1], approx: false };
  const [lat, lng] = area_centers[spot.area];
  let h = 0;
  for (const ch of spot.name) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return { lat: lat + ((h % 100) - 50) / 1500, lng: lng + ((Math.floor(h / 100) % 100) - 50) / 1500, approx: true };
}

// area 입력(동쪽/서쪽/서귀포/제주시)을 데이터의 area("동쪽(성산)" 등)와 맞춘다.
const inArea = (spot, area) => spot.area === area || spot.area.startsWith(area + '(');

// withCoords: 지도 화면용 좌표 포함 여부. Claude 도구 결과(runTool)에는 넣지 않는다.
function findSpots({ area, indoor } = {}, { withCoords = false } = {}) {
  if (!AREAS.includes(area)) {
    return { error: 'area는 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나여야 합니다.' };
  }

  const matched = spots.filter(
    (s) => inArea(s, area) && (typeof indoor !== 'boolean' || s.indoor === indoor)
  );

  const result = {
    count: Math.min(matched.length, MAX_RESULTS),
    total_matched: matched.length,
    spots: matched.slice(0, MAX_RESULTS).map((s) => ({
      name: s.name,
      areas: [s.area],
      indoor: s.indoor,
      description: s.type,
      ...(withCoords ? locate(s) : {}),
    })),
  };

  if (matched.length === 0) {
    result.message = '조건에 맞는 장소가 목록에 없습니다. 목록 밖의 장소를 지어내지 마세요.';
  }
  return result;
}

const findSpotsTool = {
  name: 'find_spots',
  description:
    '제주특별자치도 관광지 목록에서 지역과 실내/야외 조건으로 장소를 찾아 최대 8곳을 돌려준다. ' +
    '각 장소는 이름(name) · 지역(areas) · 실내 여부(indoor) · 설명(description)을 담는다. ' +
    '이 목록이 유일한 근거이며 목록 밖 장소는 없다. 결과에 없는 장소는 존재하지 않는 것으로 취급하고, ' +
    '추천하거나 지어내지 않는다. 운영시간 · 요금 · 휴무는 목록에 없으므로 안내하지 않는다.',
  input_schema: {
    type: 'object',
    properties: {
      area: {
        type: 'string',
        enum: AREAS,
        description: '찾을 지역. 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나.',
      },
      indoor: {
        type: 'boolean',
        description: 'true면 실내 장소만, false면 야외 장소만. 생략하면 구분하지 않는다.',
      },
    },
    required: ['area'],
    additionalProperties: false,
  },
};


// ---- get_weather (Open-Meteo, API 키 불필요) ----
const AREA_POINTS = {
  제주시: [33.4996, 126.5312],
  동쪽: [33.4580, 126.8800],
  서쪽: [33.3900, 126.2400],
  서귀포: [33.2541, 126.5600],
};

const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '안개',
  51: '이슬비', 53: '이슬비', 55: '이슬비', 56: '어는 이슬비', 57: '어는 이슬비',
  61: '비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '어는 비',
  71: '눈', 73: '눈', 75: '많은 눈', 77: '싸락눈',
  80: '소나기', 81: '소나기', 82: '강한 소나기', 85: '눈 소나기', 86: '눈 소나기',
  95: '뇌우', 96: '우박 동반 뇌우', 99: '우박 동반 뇌우',
};
const wmo = (code) => WMO[code] || '알 수 없음';

async function getWeather({ area } = {}) {
  if (!AREA_POINTS[area]) {
    return { error: 'area는 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나여야 합니다.' };
  }
  const [lat, lng] = AREA_POINTS[area];
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lng}` +
    '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=Asia%2FSeoul&forecast_days=3';

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    return { error: `날씨를 가져오지 못했습니다: ${e.message}` };
  }

  const c = data.current;
  const forecast = data.daily.time.map((date, i) => ({
    date,
    weather: wmo(data.daily.weather_code[i]),
    temp_min: data.daily.temperature_2m_min[i],
    temp_max: data.daily.temperature_2m_max[i],
    rain_probability: data.daily.precipitation_probability_max[i],
  }));
  const rainyNow = c.precipitation > 0 || c.weather_code >= 51;

  return {
    area,
    now: {
      time: c.time,
      weather: wmo(c.weather_code),
      temperature: c.temperature_2m,
      feels_like: c.apparent_temperature,
      precipitation_mm: c.precipitation,
      wind_kmh: c.wind_speed_10m,
    },
    forecast,
    // 현재 비가 오거나 오늘 강수확률이 높으면 실내 장소를 우선 권한다.
    prefer_indoor: rainyNow || forecast[0].rain_probability >= 60,
  };
}

const getWeatherTool = {
  name: 'get_weather',
  description:
    '제주 지역(동쪽 · 서쪽 · 서귀포 · 제주시)의 현재 날씨와 오늘부터 3일간 예보(날씨 · 기온 · 강수확률)를 Open-Meteo에서 가져온다. ' +
    'prefer_indoor가 true면 비 등으로 실내 장소를 우선 추천하는 편이 좋다는 뜻이다. ' +
    '장소 목록은 주지 않으므로 장소는 find_spots로 찾는다.',
  input_schema: {
    type: 'object',
    properties: {
      area: {
        type: 'string',
        enum: AREAS,
        description: '날씨를 볼 지역. 동쪽 · 서쪽 · 서귀포 · 제주시 중 하나.',
      },
    },
    required: ['area'],
    additionalProperties: false,
  },
};

// Gemini function calling은 additionalProperties를 받지 않고 type을 대문자로 쓴다.
function toGeminiSchema(schema) {
  const { additionalProperties, ...rest } = schema;
  const out = { ...rest, type: String(schema.type).toUpperCase() };
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  return out;
}
const toGeminiDeclaration = (t) => ({
  name: t.name,
  description: t.description,
  parameters: toGeminiSchema(t.input_schema),
});

async function runTool(name, input) {
  if (name === 'find_spots') return findSpots(input);
  if (name === 'get_weather') return getWeather(input);
  return { error: `알 수 없는 도구: ${name}` };
}

const tools = [findSpotsTool, getWeatherTool];
const geminiTools = [{ functionDeclarations: tools.map(toGeminiDeclaration) }];

module.exports = { tools, geminiTools, findSpotsTool, getWeatherTool, findSpots, getWeather, runTool };
