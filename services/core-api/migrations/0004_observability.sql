-- 0004: Phase 4 operations: trace context on outbox events, aggregate outbox
-- health for /metrics, and read access to the migration ledger for /readyz.
--
-- Same rules as 0001: runs as the schema owner; the app role gets only what is
-- granted below, and nothing here exposes a tenant's rows to another tenant.

-- The W3C traceparent of the request that enqueued the event, so the work the
-- worker does later (extraction, signals) joins the upload's trace.
ALTER TABLE outbox ADD COLUMN traceparent text
  CHECK (traceparent IS NULL OR traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- claim_outbox() now also returns the traceparent. Its return type changes, so
-- it is dropped and recreated; the body and locking are exactly as in 0001.
DROP FUNCTION claim_outbox(integer, integer);
CREATE FUNCTION claim_outbox(batch integer, lease_seconds integer)
  RETURNS TABLE (id bigint, tenant_id uuid, event_id uuid, topic text, payload jsonb, attempts integer, traceparent text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE outbox o
       SET locked_until = now() + make_interval(secs => lease_seconds),
           attempts = o.attempts + 1
     WHERE o.id IN (
       SELECT p.id FROM outbox p
        WHERE p.processed_at IS NULL
          AND p.dead_at IS NULL
          AND p.available_at <= now()
          AND (p.locked_until IS NULL OR p.locked_until < now())
        ORDER BY p.available_at, p.id
        LIMIT least(batch, 100)
        FOR UPDATE SKIP LOCKED
     )
    RETURNING o.id, o.tenant_id, o.event_id, o.topic, o.payload, o.attempts, o.traceparent
  $$;
REVOKE ALL ON FUNCTION claim_outbox(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox(integer, integer) TO invoiceiq_app;

-- Three numbers across all tenants, for alerting on a stuck or failing queue.
-- Counts only: no ids, topics, payloads or tenant names leave this function.
CREATE FUNCTION outbox_stats()
  RETURNS TABLE (pending bigint, dead bigint, oldest_pending_age_seconds double precision)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT count(*) FILTER (WHERE processed_at IS NULL AND dead_at IS NULL),
           count(*) FILTER (WHERE dead_at IS NOT NULL),
           coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE processed_at IS NULL AND dead_at IS NULL)), 0)::double precision
      FROM outbox
  $$;
REVOKE ALL ON FUNCTION outbox_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_stats() TO invoiceiq_app;

-- /readyz compares the applied migrations with the ones the build ships.
GRANT SELECT ON schema_migrations TO invoiceiq_app;
