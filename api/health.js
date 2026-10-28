// GET /api/health → 배포 상태 점검(키 값은 노출하지 않고 존재 여부만 알려 준다)
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    vercelEnv: process.env.VERCEL_ENV || null,
    node: process.version,
    time: new Date().toISOString(),
  });
};
