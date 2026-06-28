-- #111 follow-up: add `ddns_update_url` column for the generic dyndns2 provider.
--
-- The dyndns2 protocol is a 2003 de-facto standard that almost every
-- DDNS service speaks (Dynu, FreeDNS / Afraid, namecheap, several
-- self-hosted solutions). The protocol shape is fixed: GET to
-- <update-url>?hostname=<host>&myip=<ip> with HTTP Basic Auth, and a
-- response body whose first whitespace-separated token is the status
-- (`good <ip>`, `nochg <ip>`, `nohost`, `badauth`, ...).
--
-- Since the only thing that varies between providers is the update
-- URL itself, we expose it as a configurable field rather than write
-- a new code path per provider. Empty string when provider is not
-- 'dyndns2'.

ALTER TABLE config ADD COLUMN ddns_update_url TEXT NOT NULL DEFAULT '';
