-- Para pipelines "genéricos" (Bit Colombia, Bit Paraguay, Bit México, etc.) que no indican
-- por sí solos qué línea de producto es (a diferencia de "Bit WiFi", "Bit Music" o
-- "Neomedia Digital", donde el nombre del pipeline ya lo dice) — así el tipo de hardware
-- correcto se puede mostrar igual, sin depender de en qué pipeline vive el trato.
alter table deals add column if not exists product_line text;
