-- TEST DOUBLE — NULMETING VOOR B2-08c: na 20261021160000-163000, vóór
-- 20261021164000. Legt vast dat de pointer-aanval op de P0-fix werkt.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
\set pre X0
\set fase 'vóór'
\set exp_ins 'OK leest 1|verwijdert 1'
\set exp_upd 'OK leest 1|verwijdert 1'
\set exp_vreemd 'OK leest 1|verwijdert 0'
\ir pointer-attack.sql
