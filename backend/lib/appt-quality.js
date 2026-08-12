/* lib/appt-quality.js — единый фильтр «мусорных» записей журнала.
 *
 * Аудит 28.07 (жалоба Босса «AI-аналитика считает мусор»): в окне 30 дней из 130
 * отменённых записей 80 оказались техническими артефактами синхронизации стара CRM/Букон:
 *   • bp_deleted   — запись удалена в стара CRM (19 шт)
 *   • not_in_bukon — фантом, отсутствующий в Буконе (58 шт)
 *   • phantom_dup  — задвоенная запись синка (3 шт)
 * AI-аналитик фильтровал только bp_deleted → показывал «111 отмен, 30.7%» вместо
 * реальных 50 (~12%). reports.js уже исключал все три — теперь исключают ВСЕ поверхности.
 *
 * Использование: `WHERE ... AND ${notArtifact('a')}` (alias таблицы appointments).
 */
const BP_ARTIFACT_STATES = ['bp_deleted', 'not_in_bukon', 'phantom_dup'];

function notArtifact(alias) {
  const p = alias ? alias + '.' : '';
  return `COALESCE(${p}legacy_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')`;
}

module.exports = { BP_ARTIFACT_STATES, notArtifact };
