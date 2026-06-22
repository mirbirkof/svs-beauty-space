/* lib/ssrf-guard.js — защита исходящих запросов (вебхуки) от SSRF (audit #18).
 *
 * Проблема: пользователь регистрирует webhook-URL, сервер сам делает на него fetch.
 * Без проверки злоумышленник укажет http://169.254.169.254/ (метаданные облака),
 * http://127.0.0.1/ или внутренний адрес RFC1918 → сервер дёрнет внутреннюю сеть
 * и утечёт креды/ответы. Решение: резолвим хост и запрещаем непубличные адреса.
 *
 * Резолв делается в МОМЕНТ запроса (а не только при создании) — иначе DNS-rebinding
 * (домен сперва указывает на публичный IP, потом на 127.0.0.1) обходит проверку.
 */
const dns = require('dns').promises;
const net = require('net');

// IPv4 в виде числа для диапазонных проверок
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
}
function inRange4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// запрещённые IPv4-диапазоны: loopback, private, link-local (вкл. cloud metadata 169.254.169.254),
// CGNAT, "this host", benchmarking, multicast, reserved, broadcast.
const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
];

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some((c) => inRange4(ip, c));
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;            // loopback / unspecified
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local / ULA
    if (low.startsWith('ff')) return true;                      // multicast
    // IPv4-mapped (::ffff:127.0.0.1) — проверяем встроенный IPv4
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
  }
  return false;
}

// Бросает, если URL не публичный http(s). Возвращает разрешённый URL.
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked_protocol');
  const host = u.hostname;
  // если хост — literal IP, проверяем напрямую
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('blocked_private_address');
    return rawUrl;
  }
  // иначе резолвим все A/AAAA и проверяем каждый адрес
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error('dns_resolve_failed'); }
  if (!addrs.length) throw new Error('dns_no_records');
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('blocked_private_address');
  }
  return rawUrl;
}

module.exports = { assertPublicHttpUrl, isBlockedIp };
