const { findSpots } = require('./tools');

// GET /api/spots?area=동쪽&indoor=true  → 지도 화면용(좌표 포함) find_spots 결과
module.exports = (req, res) => {
  const { area, indoor } = req.query;
  const input = { area };
  if (indoor === 'true') input.indoor = true;
  if (indoor === 'false') input.indoor = false;

  const result = findSpots(input, { withCoords: true });
  res.status(result.error ? 400 : 200).json(result);
};
