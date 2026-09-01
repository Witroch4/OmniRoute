-- Migration: normalized-spend attribution on usage_history.
-- billed_provider/billed_model record the pair the CLIENT asked for when a model
-- budget rule silently rerouted the request. NULL means no redirect happened, so
-- normalized spend equals real spend and every pre-existing row reads correctly
-- through COALESCE(billed_x, x) with no backfill.
ALTER TABLE usage_history ADD COLUMN billed_provider TEXT;
ALTER TABLE usage_history ADD COLUMN billed_model TEXT;
