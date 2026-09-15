-- ═══════════════════════════════════════════════════════
-- Нотатка #158 — «Адміністрація» показувала майстрів упереміш
--
-- Причина: у картці співробітника роль ВИВОДИЛАСЬ із галочки «Надає послуги»
-- (provides ? 'master' : 'admin'). Варто було зняти галочку — і перукар чи майстер
-- манікюру мовчки ставав «адміністратором»: зникав зі списку майстрів у журналі
-- та онлайн-записі й з'являвся у фільтрі «Адміністрація».
--
-- Тут виправляємо наслідок у даних: людям з роллю 'admin', у яких є ПРИВ'ЯЗАНІ ПОСЛУГИ
-- у прайсі, повертаємо роль 'master' і ознаку provides_services.
-- Наявність послуг — об'єктивний критерій: адміністратор послуг у прайсі не має.
-- Нічого не видаляємо, справжніх адміністраторів (0 послуг) не чіпаємо.
-- ═══════════════════════════════════════════════════════

UPDATE masters m
   SET staff_role = 'master',
       provides_services = true
 WHERE m.staff_role = 'admin'
   AND m.merged_into IS NULL
   AND EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id = m.id);

-- Зворотній випадок: людина з посадою «Власник», без жодної послуги і без жодного запису
-- лишалась позначена як «Майстер» (міграція 051 ставила 'master' усім, у кого роль була порожня).
-- Це теж розбіжність між посадою в картці і групою в реєстрі.
UPDATE masters m
   SET staff_role = 'owner'
 WHERE m.merged_into IS NULL
   AND m.staff_role = 'master'
   AND m.specialty ILIKE '%власн%'
   AND NOT EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM appointments a  WHERE a.master_id  = m.id);
