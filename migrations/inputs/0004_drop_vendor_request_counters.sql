-- inputs DB: drop vendor_request_counters (created in 0003).
-- Its only consumer was shared/d1_rate_limiter.js, which was deleted together
-- with the Twelve Data integration in #193. Nothing in src/ reads or writes
-- this table any more. 0003 is left untouched (applied migrations are not
-- edited); this migration removes the table it created.
DROP TABLE IF EXISTS vendor_request_counters;
