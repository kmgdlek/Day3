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

function runTool(name, input) {
  if (name === 'find_spots') return findSpots(input);
  return { error: `알 수 없는 도구: ${name}` };
}

module.exports = { tools: [findSpotsTool], findSpotsTool, findSpots, runTool };
