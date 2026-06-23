'use strict';
/**
 * lib/branch-scope.js — изоляция филиалов (аудит 23.06, #2).
 *
 * Проблема: branch_id хранился только в JWT-claim пользователя, но НЕ
 * принуждался в запросах. Сотрудник, привязанный к филиалу A, мог через
 * branch-параметр читать/писать данные филиала B того же тенанта (IDOR).
 *
 * Решение (backward-compatible):
 *   • «привязан к филиалу» = у юзера задан branch_id И он не owner (level<999).
 *   • для таких юзеров любой branch/branch_id в query и body ЗАЖИМАЕТСЯ к его
 *     собственному филиалу — нельзя запросить чужой.
 *   • req.scopedBranchId = эффективный филиал (или null для owner/одно-салона).
 *   • helper branchAndClause(req, col) добавляет «AND col=$n» в запросы там,
 *     где это уместно.
 *
 * ВАЖНО про односалонный режим: у владельца и сотрудников branch_id = null
 * (или роль owner level 999) → isBranchBound = false → НИКАКОГО фильтра,
 * поведение не меняется. Ограничение включается только для реально
 * мульти-филиальных тенантов с привязанными сотрудниками.
 */

const OWNER_LEVEL = 999;

function isBranchBound(user) {
  if (!user) return false;
  if (user.branch_id == null) return false;            // не привязан → видит всё
  if ((user.role_level || 0) >= OWNER_LEVEL) return false; // owner/legacy-admin → всё
  // явное кросс-филиальное право снимает ограничение
  const perms = user.permissions || [];
  if (Array.isArray(perms) && (perms.includes('*') || perms.includes('branches.all'))) return false;
  return true;
}

/**
 * Зажимает branch-параметры запроса к филиалу привязанного юзера.
 * Вызывается централизованно из requirePerm после установки req.user.
 * No-op для owner / одно-салонных юзеров.
 */
function enforceBranch(req) {
  const u = req.user;
  if (!isBranchBound(u)) { req.scopedBranchId = null; return; }
  const bid = u.branch_id;
  req.scopedBranchId = bid;
  // query: и branch, и branch_id — перетираем на свой филиал
  if (req.query) {
    if (req.query.branch_id !== undefined) req.query.branch_id = String(bid);
    if (req.query.branch !== undefined) req.query.branch = String(bid);
  }
  // body: дефолт + зажим (нельзя писать в чужой филиал)
  if (req.body && typeof req.body === 'object') {
    if (req.body.branch_id === undefined || req.body.branch_id === null || Number(req.body.branch_id) !== Number(bid)) {
      req.body.branch_id = bid;
    }
  }
}

/**
 * Фрагмент WHERE для привязанного юзера. Для owner/одно-салона — пусто.
 *   const b = branchAndClause(req, 'o.branch_id', params.length);
 *   sql += b.sql; params.push(...b.params);
 */
function branchAndClause(req, col, paramOffset = 0) {
  if (req.scopedBranchId == null) return { sql: '', params: [] };
  return { sql: ` AND ${col} = $${paramOffset + 1}`, params: [req.scopedBranchId] };
}

module.exports = { isBranchBound, enforceBranch, branchAndClause, OWNER_LEVEL };
