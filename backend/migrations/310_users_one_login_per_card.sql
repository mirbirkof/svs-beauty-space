-- 10.10 (нотатка #170, Власник): «неверно написал професию, пришлось удалить, а когда
-- создал с таким же именем — все объединились».
-- Сервер мовчки чіпляв новий логін до вже наявної (навіть звільненої) картки з тим самим
-- імʼям → на одну картку «Ася» (masters #71) лягло ТРИ логіни (users 69, 70, 71).
-- Тепер: 1) лишні логіни-дублі відчіпляються від картки і позначаються злитими (НЕ
-- видаляються — історія і аудит лишаються); 2) база сама не дасть двох логінів на одну
-- людину — хоч би який маршрут спробував. Додавальна, ідемпотентна.
ALTER TABLE users ADD COLUMN IF NOT EXISTS merged_into INTEGER;

-- Лишаємо по картці ОДИН логін: активний, а з однакових — найстаріший (той, з яким людина
-- вже працювала). Решта — неактивні, без привʼязки до картки, з позначкою «злито в #N».
WITH ranked AS (
  SELECT id, master_id,
         FIRST_VALUE(id) OVER (PARTITION BY master_id ORDER BY is_active DESC, (last_login_at IS NOT NULL) DESC, id) AS keep_id
    FROM users
   WHERE master_id IS NOT NULL AND merged_into IS NULL
)
UPDATE users u
   SET merged_into = r.keep_id, master_id = NULL, is_active = false, updated_at = NOW()
  FROM ranked r
 WHERE u.id = r.id AND r.id <> r.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS users_one_login_per_master
  ON users (master_id) WHERE master_id IS NOT NULL;
