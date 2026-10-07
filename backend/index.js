// Точка входа Яндекс Cloud Functions (среда nodejs22, обработчик index.handler).
// Адрес вызова: https://functions.yandexcloud.net/<id>?r=/api/...
let mods;
module.exports.handler = async function (event, context) {
  mods = mods || await Promise.all([import('./app.mjs'), import('./db-ydb.mjs')]);
  const [{ handle }, { db, tokenProvider }] = mods;
  if (context && context.token && context.token.access_token) tokenProvider.token = context.token.access_token;
  const q = { ...(event.queryStringParameters || {}) };
  const path = q.r || event.path || '/';
  delete q.r;
  const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const headers = event.headers || {};
  const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp)
    || String(headers['X-Forwarded-For'] || headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const res = await handle({ method: event.httpMethod || 'GET', path, query: q, headers, body, ip }, db, process.env);
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
};
