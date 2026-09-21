-- Frecuencia de facturación del TRATO (no del producto) — más directo: quien cierra el
-- trato sabe si el contrato se factura mensual o anual, sin depender de que cada producto
-- del catálogo esté bien clasificado. Este campo pasa a ser la base real de MRR/ARR;
-- products.billing_frequency (migración 030) se queda pero deja de usarse ahí.
alter table deals add column if not exists billing_frequency text default 'mensual'
  check (billing_frequency in ('mensual', 'anual', 'unico'));

-- Tipo de hardware del trato (router, pantalla, parlante, etc.) — las opciones que se
-- muestran cambian según el pipeline (WiFi / Music / Signage), pero se guarda como texto
-- libre para no tener que mantener una tabla de catálogo aparte.
alter table deals add column if not exists hardware_type text;
