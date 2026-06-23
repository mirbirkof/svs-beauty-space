/* ════════════════════════════════════════════════════════════════
   S3-совместимая выгрузка (AWS Signature V4) — без внешних зависимостей.
   Работает с DigitalOcean Spaces, Cloudflare R2, Backblaze B2, AWS S3,
   MinIO и любым S3-совместимым хранилищем.

   Конфиг через переменные окружения (задаются в Render → Environment):
     BACKUP_S3_ENDPOINT  напр. https://fra1.digitaloceanspaces.com
     BACKUP_S3_REGION    напр. fra1  (для AWS — us-east-1 и т.п.)
     BACKUP_S3_BUCKET    имя Space/bucket
     BACKUP_S3_KEY       access key id
     BACKUP_S3_SECRET    secret access key
     BACKUP_S3_PREFIX    (необяз.) папка-префикс, по умолч. svs-crm-backups/

   Если ключи не заданы — isConfigured() === false, загрузка пропускается
   (бэкап остаётся локальным, без падения).
   ════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

function cfg() {
  return {
    endpoint: process.env.BACKUP_S3_ENDPOINT || '',
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    bucket: process.env.BACKUP_S3_BUCKET || '',
    key: process.env.BACKUP_S3_KEY || '',
    secret: process.env.BACKUP_S3_SECRET || '',
    prefix: (process.env.BACKUP_S3_PREFIX || 'svs-crm-backups/').replace(/^\/+/, ''),
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.endpoint && c.bucket && c.key && c.secret);
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
// URI-encode по правилам AWS, '/' сохраняем в пути
function enc(str, keepSlash) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
}

/**
 * Загружает объект в S3-совместимое хранилище.
 * @param {string} objectKey ключ без префикса (префикс добавляется автоматически)
 * @param {Buffer} body тело
 * @param {string} contentType
 * @returns {Promise<{url:string, key:string, bucket:string}>}
 */
function uploadObject(objectKey, body, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new Error('s3-not-configured'));
    const c = cfg();
    const fullKey = (c.prefix + objectKey).replace(/^\/+/, '');
    const base = new URL(c.endpoint);
    const host = base.host;
    // path-style: /{bucket}/{key} — максимально совместимо между провайдерами
    const canonicalUri = '/' + enc(c.bucket, true) + '/' + enc(fullKey, true);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body);

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac('AWS4' + c.secret, dateStamp);
    const kRegion = hmac(kDate, c.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = https.request({
      method: 'PUT',
      host: base.hostname,
      port: base.port || 443,
      path: canonicalUri,
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization,
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ url: `${c.endpoint.replace(/\/$/, '')}/${c.bucket}/${fullKey}`, key: fullKey, bucket: c.bucket });
        } else {
          reject(new Error(`s3-upload-failed ${res.statusCode}: ${String(data).slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('s3-upload-timeout')));
    req.write(body);
    req.end();
  });
}

/**
 * Скачивает объект из S3-совместимого хранилища (SigV4 GET).
 * Нужен для проверки восстановимости бэкапа (download → распаковать → проверить).
 * @param {string} objectKey ключ без префикса (префикс добавляется автоматически)
 * @returns {Promise<Buffer>} тело объекта
 */
function getObject(objectKey) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new Error('s3-not-configured'));
    const c = cfg();
    const fullKey = (c.prefix + objectKey).replace(/^\/+/, '');
    const base = new URL(c.endpoint);
    const host = base.host;
    const canonicalUri = '/' + enc(c.bucket, true) + '/' + enc(fullKey, true);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(Buffer.alloc(0)); // пустое тело у GET

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'GET', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac('AWS4' + c.secret, dateStamp);
    const kRegion = hmac(kDate, c.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = https.request({
      method: 'GET',
      host: base.hostname,
      port: base.port || 443,
      path: canonicalUri,
      headers: {
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`s3-get-failed ${res.statusCode}: ${body.toString().slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('s3-get-timeout')));
    req.end();
  });
}

module.exports = { isConfigured, uploadObject, getObject, _cfg: cfg };
