-- Runtime readiness marker for the exact schema contract. Manual application
-- only, after the full read-only schema verifier is VERIFIED on the isolated
-- target. Every future database migration must change this contract id and
-- require a newly bound deployment activation.

INSERT INTO `settings` (`skey`, `svalue`)
VALUES ('node_schema_contract_id', 'nodejs-shortener-mariadb-10.11-v1')
ON DUPLICATE KEY UPDATE `svalue` = VALUES(`svalue`);
