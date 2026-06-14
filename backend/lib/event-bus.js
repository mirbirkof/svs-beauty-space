/* ═══════════════════════════════════════════════════════
   INF-01 — EVENT BUS (шина доменных событий)

   Единая точка публикации доменных событий. Любой модуль вызывает
   bus.emit('appointment.completed', { ... }) вместо прямых вызовов
   друг друга. Подписчики (уведомления, лояльность, аналитика)
   реагируют через bus.on('appointment.completed', handler).

   Гарантии:
   - событие СНАЧАЛА персистится в domain_events (durable outbox/журнал),
     поэтому переживает падение процесса и доступно для replay/аудита;
   - подписчики вызываются best-effort и ИЗОЛИРОВАННО: ошибка одного
     обработчика не валит остальных и не валит вызывающий код;
   - поддержка wildcard '*' — подписка на все события (логи/аналитика);
   - полностью additive: не трогает существующие модули, они продолжают
     работать без шины, пока не начнут на неё подписываться.
   ═══════════════════════════════════════════════════════ */
const { EventEmitter } = require('events');
const { getPool } = require('../db-pg');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';

const emitter = new EventEmitter();
emitter.setMaxListeners(100); // много модулей-подписчиков — это норма

/**
 * Подписаться на доменное событие.
 * @param {string} type   — тип события или '*' для всех
 * @param {(evt:object)=>any} handler — получает { id, event_type, entity_type, entity_id, actor, payload, created_at }
 */
function on(type, handler) {
  emitter.on(type, handler);
  return () => emitter.off(type, handler); // отписка
}

/**
 * Опубликовать доменное событие.
 * @param {string} eventType — напр. 'appointment.completed'
 * @param {object} payload   — произвольные данные события
 * @param {object} [opts]    — { entityType, entityId, actor, tenantId }
 * @returns {Promise<object|null>} сохранённая запись события (или null при сбое БД)
 */
async function emit(eventType, payload = {}, opts = {}) {
  const {
    entityType = null,
    entityId = null,
    actor = 'system',
    tenantId = DEFAULT_TENANT,
  } = opts;

  let evt = null;
  // 1) Durable: сначала пишем в outbox/журнал
  try {
    const r = await getPool().query(
      `INSERT INTO domain_events (tenant_id, event_type, entity_type, entity_id, actor, payload)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, tenant_id, event_type, entity_type, entity_id, actor, payload, status, created_at`,
      [tenantId, eventType, entityType, entityId == null ? null : String(entityId), actor,
       payload ? JSON.stringify(payload) : null]
    );
    evt = r.rows[0];
  } catch (e) {
    // БД недоступна — не валим вызывающий код, но и подписчиков не зовём вслепую
    console.error(`[event-bus] persist failed (${eventType}): ${e.message}`);
    evt = { id: null, event_type: eventType, entity_type: entityType, entity_id: entityId, actor, payload, created_at: new Date().toISOString() };
  }

  // 2) Best-effort: зовём in-process подписчиков изолированно
  let handlerCount = 0;
  let firstError = null;
  const targets = [...emitter.listeners(eventType), ...emitter.listeners('*')];
  for (const fn of targets) {
    try {
      await fn(evt);
      handlerCount++;
    } catch (e) {
      firstError = firstError || e.message;
      console.error(`[event-bus] handler error (${eventType}): ${e.message}`);
    }
  }

  // 3) Отмечаем результат обработки (best-effort)
  if (evt && evt.id != null) {
    const status = firstError ? 'failed' : 'handled';
    try {
      await getPool().query(
        `UPDATE domain_events SET status=$1, handler_count=$2, error=$3, handled_at=NOW() WHERE id=$4`,
        [status, handlerCount, firstError, evt.id]
      );
    } catch (_) { /* журнал статуса не критичен */ }
  }

  return evt;
}

module.exports = { emit, on, DEFAULT_TENANT };
