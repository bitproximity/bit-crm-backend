-- Para calcular MRR/ARR hace falta saber qué productos son recurrentes (se facturan cada
-- mes o cada año) y cuáles son de pago único (ej. instalación, setup) — hoy no existe
-- ningún campo que distinga eso. Por defecto queda "mensual" porque la mayoría del
-- catálogo es de suscripción; hay que revisar y corregir los que sean de pago único
-- (ej. "Comisiones", cualquier producto de instalación/setup) desde Productos en el CRM.
alter table products add column if not exists billing_frequency text default 'mensual'
  check (billing_frequency in ('mensual', 'anual', 'unico'));
