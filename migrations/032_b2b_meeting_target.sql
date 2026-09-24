-- Meta mensual de reuniones por cliente de Bit Prospect, para medir mes a mes cuánto falta
-- para llegar al objetivo. Se aplica contra "Realizadas" (reuniones que de verdad se dieron),
-- no "Programadas" — es la métrica real de resultado, no de agenda.
alter table companies add column if not exists b2b_meeting_target integer;
