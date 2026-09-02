-- Durable image-job ledger foundation for MariaDB 10.11.
--
-- This table deliberately stores only generated, storage-relative keys. The
-- application must resolve those keys beneath its configured private/public
-- roots; credentials and absolute server paths do not belong in this ledger.
--
-- Ready-on-create invariant: a caller may attach an image to a link only when
-- state='ready', publication_state='published' and
-- compensation_state='not_required'. A publishing or ambiguous job must never
-- be exposed through a public link.

CREATE TABLE IF NOT EXISTS image_job_ledger_v1 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  domain_id SMALLINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  session_scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ownership_expires_at DATETIME(6) NOT NULL,
  input_storage_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  output_storage_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  state ENUM(
    'requested',
    'queued',
    'processing',
    'output_ready',
    'publishing',
    'ready',
    'failed',
    'compensation_required',
    'compensating',
    'compensated',
    'manual_review'
  ) NOT NULL DEFAULT 'requested',
  publication_state ENUM(
    'private',
    'publishing',
    'published',
    'unknown',
    'removed'
  ) NOT NULL DEFAULT 'private',
  compensation_state ENUM(
    'not_required',
    'required',
    'in_progress',
    'complete'
  ) NOT NULL DEFAULT 'not_required',

  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  compensation_attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_compensation_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  next_attempt_at DATETIME(6) NULL,
  first_attempt_at DATETIME(6) NULL,
  last_attempt_at DATETIME(6) NULL,
  last_compensation_attempt_at DATETIME(6) NULL,

  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_acquired_at DATETIME(6) NULL,
  lease_expires_at DATETIME(6) NULL,

  output_ready_at DATETIME(6) NULL,
  result_source_width INT UNSIGNED NULL,
  result_source_height INT UNSIGNED NULL,
  published_at DATETIME(6) NULL,
  ready_at DATETIME(6) NULL,
  failed_at DATETIME(6) NULL,
  compensation_requested_at DATETIME(6) NULL,
  compensated_at DATETIME(6) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_error_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_image_job_ledger_job (job_id),
  UNIQUE KEY uq_image_job_ledger_request (request_key),
  UNIQUE KEY uq_image_job_ledger_input (input_storage_key),
  UNIQUE KEY uq_image_job_ledger_output (output_storage_key),
  KEY ix_image_job_dispatch (state, next_attempt_at, id),
  KEY ix_image_job_expired_lease (state, lease_expires_at, id),
  KEY ix_image_job_compensation (compensation_state, next_attempt_at, id),
  KEY ix_image_job_owner_history (user_id, domain_id, created_at, id),
  KEY ix_image_job_terminal_retention (state, updated_at, id),

  CONSTRAINT chk_image_job_id CHECK (job_id REGEXP '^[0-9a-f]{32}$'),
  CONSTRAINT chk_image_job_request_key CHECK (request_key REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_image_job_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_image_job_scope_hash CHECK (session_scope_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_image_job_error_fingerprint CHECK (
    last_error_fingerprint IS NULL OR last_error_fingerprint REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_image_job_error_code CHECK (
    last_error_code IS NULL OR last_error_code REGEXP '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT chk_image_job_relative_keys CHECK (
    CHAR_LENGTH(input_storage_key) BETWEEN 1 AND 255
    AND CHAR_LENGTH(output_storage_key) BETWEEN 1 AND 255
    AND LEFT(input_storage_key, 1) <> '/'
    AND LEFT(output_storage_key, 1) <> '/'
    AND LOCATE(CHAR(92), input_storage_key) = 0
    AND LOCATE(CHAR(92), output_storage_key) = 0
    AND LOCATE(':', input_storage_key) = 0
    AND LOCATE(':', output_storage_key) = 0
    AND LOCATE('..', input_storage_key) = 0
    AND LOCATE('..', output_storage_key) = 0
  ),
  CONSTRAINT chk_image_job_attempts CHECK (
    max_attempts BETWEEN 1 AND 20
    AND attempt_count <= max_attempts
    AND max_compensation_attempts BETWEEN 1 AND 20
    AND compensation_attempt_count <= max_compensation_attempts
  ),
  CONSTRAINT chk_image_job_lease_shape CHECK (
    (
      state IN ('processing', 'output_ready', 'publishing', 'compensating')
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_acquired_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > lease_acquired_at
    )
    OR
    (
      state NOT IN ('processing', 'output_ready', 'publishing', 'compensating')
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT chk_image_job_state_shape CHECK (
    (state IN ('requested', 'queued', 'processing', 'output_ready', 'failed')
      AND publication_state = 'private' AND compensation_state = 'not_required')
    OR (state = 'publishing'
      AND publication_state = 'publishing' AND compensation_state = 'not_required')
    OR (state = 'ready'
      AND publication_state = 'published' AND compensation_state = 'not_required')
    OR (state = 'compensation_required'
      AND publication_state = 'unknown' AND compensation_state = 'required')
    OR (state = 'compensating'
      AND publication_state = 'unknown' AND compensation_state = 'in_progress')
    OR (state = 'compensated'
      AND publication_state = 'removed' AND compensation_state = 'complete')
    OR (state = 'manual_review'
      AND publication_state = 'unknown' AND compensation_state = 'required')
  ),
  CONSTRAINT chk_image_job_retry_time CHECK (
    next_attempt_at IS NULL
    OR (state IN ('queued', 'compensation_required') AND next_attempt_at >= updated_at)
  ),
  CONSTRAINT chk_image_job_attempt_times CHECK (
    (
      attempt_count = 0
      AND first_attempt_at IS NULL
      AND last_attempt_at IS NULL
    )
    OR
    (
      attempt_count > 0
      AND first_attempt_at IS NOT NULL
      AND last_attempt_at IS NOT NULL
      AND last_attempt_at >= first_attempt_at
    )
  ),
  CONSTRAINT chk_image_job_compensation_attempt_time CHECK (
    (compensation_attempt_count = 0 AND last_compensation_attempt_at IS NULL)
    OR (compensation_attempt_count > 0 AND last_compensation_attempt_at IS NOT NULL)
  ),
  CONSTRAINT chk_image_job_compensation_request CHECK (
    (
      state IN ('compensation_required', 'compensating', 'compensated', 'manual_review')
      AND compensation_requested_at IS NOT NULL
    )
    OR
    (
      state NOT IN ('compensation_required', 'compensating', 'compensated', 'manual_review')
      AND compensation_requested_at IS NULL
    )
  ),
  CONSTRAINT chk_image_job_ready_time CHECK (
    (state = 'ready' AND published_at IS NOT NULL AND ready_at IS NOT NULL AND ready_at >= published_at
      AND result_source_width IS NOT NULL AND result_source_height IS NOT NULL)
    OR (state <> 'ready' AND published_at IS NULL AND ready_at IS NULL)
  ),
  CONSTRAINT chk_image_job_result_shape CHECK (
    (result_source_width IS NULL AND result_source_height IS NULL)
    OR (result_source_width IS NOT NULL AND result_source_height IS NOT NULL
      AND result_source_width BETWEEN 1 AND 100000 AND result_source_height BETWEEN 1 AND 100000)
  ),
  CONSTRAINT chk_image_job_compensation_time CHECK (
    (state = 'compensated' AND compensated_at IS NOT NULL)
    OR (state <> 'compensated' AND compensated_at IS NULL)
  ),
  CONSTRAINT chk_image_job_updated_time CHECK (
    updated_at >= created_at AND ownership_expires_at > created_at
  )
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci
  COMMENT='Durable ready-on-create image workflow and restart recovery ledger';
