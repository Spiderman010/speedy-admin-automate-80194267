-- TEST DOUBLE — NULMETING VOOR R-01: na 20261021164000, vóór 20261021165000.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
\set pre C0
\set fase 'vóór'
\set exp_claim 'OK leest 1|verwijdert 1'
\ir pointer-claim.sql
