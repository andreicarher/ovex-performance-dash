// api/meta-insights.js
// Función serverless: el navegador le pide datos a ESTA función, y esta función
// (que corre en el servidor de Vercel, nunca en el navegador) le pega a la Graph
// API de Meta usando el token guardado como variable de entorno. El token nunca
// se expone al cliente.

const AD_ACCOUNT_ID = '1423569388535724';
const GRAPH_VERSION = 'v26.0';

// Lista blanca de breakdowns permitidos, para no dejar pasar cualquier cosa al query.
const ALLOWED_BREAKDOWNS = [
  'age', 'gender', 'region', 'country', 'device_platform',
  'publisher_platform', 'platform_position', 'impression_device',
];

module.exports = async (req, res) => {
  const TOKEN = process.env.META_ACCESS_TOKEN;

  if (!TOKEN) {
    res.status(500).json({ error: 'META_ACCESS_TOKEN no está configurado en las variables de entorno de Vercel.' });
    return;
  }

  const breakdownParam = String(req.query.breakdowns || '');
  const breakdowns = breakdownParam.split(',').map((b) => b.trim()).filter(Boolean);

  for (const b of breakdowns) {
    if (!ALLOWED_BREAKDOWNS.includes(b)) {
      res.status(400).json({ error: `Breakdown no permitido: ${b}` });
      return;
    }
  }

  const datePreset = req.query.date_preset || 'maximum';
  const timeRangeParam = req.query.time_range; // JSON string {"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  const level = req.query.level === 'ad' ? 'ad' : 'account';
  const timeIncrement = req.query.time_increment; // ej. "1" para granularidad diaria

  // A nivel "ad" necesitamos los nombres para poder mostrarlos (campaña, adset,
  // anuncio) — a nivel "account" no aplican esos campos.
  const baseFields = 'spend,reach,impressions,clicks,actions,action_values,purchase_roas';
  const fields = level === 'ad'
    ? `ad_id,ad_name,adset_name,campaign_name,${baseFields}`
    : baseFields;

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/act_${AD_ACCOUNT_ID}/insights`);
  url.searchParams.set('fields', fields);
  if (timeRangeParam) {
    try {
      const tr = JSON.parse(timeRangeParam);
      if (!tr.since || !tr.until) throw new Error('time_range necesita since y until');
      url.searchParams.set('time_range', JSON.stringify(tr));
    } catch (e) {
      res.status(400).json({ error: 'time_range inválido: ' + e.message });
      return;
    }
  } else {
    url.searchParams.set('date_preset', datePreset);
  }
  url.searchParams.set('level', level);
  url.searchParams.set('limit', '500');
  if (breakdowns.length) url.searchParams.set('breakdowns', breakdowns.join(','));
  if (timeIncrement) url.searchParams.set('time_increment', timeIncrement);
  url.searchParams.set('access_token', TOKEN);

  try {
    // Meta pagina las respuestas grandes (por ejemplo, muchos anuncios x muchos
    // días). Antes nunca hacía falta seguir la paginación porque solo pedíamos
    // agregados de cuenta o desgloses chicos (edad, género, etc.) — a nivel
    // anuncio con granularidad diaria sí puede haber cientos de filas.
    let allData = [];
    let nextUrl = url.toString();
    let pages = 0;
    while (nextUrl && pages < 30) {
      const metaRes = await fetch(nextUrl);
      const data = await metaRes.json();
      if (data.error) {
        res.status(400).json({ error: data.error.message, code: data.error.code, type: data.error.type });
        return;
      }
      allData = allData.concat(data.data || []);
      nextUrl = data.paging && data.paging.next ? data.paging.next : null;
      pages++;
    }

    // Cachea la respuesta 1 hora en el CDN de Vercel para no golpear la API de
    // Meta en cada visita al dashboard.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ data: allData });
  } catch (err) {
    res.status(500).json({ error: 'Error llamando a la Graph API de Meta: ' + err.message });
  }
};
