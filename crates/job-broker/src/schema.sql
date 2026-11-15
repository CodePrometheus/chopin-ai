CREATE TABLE IF NOT EXISTS chopin_jobs (
    scope UUID NOT NULL,
    operation UUID NOT NULL,
    content BYTEA NOT NULL,
    state BYTEA NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    drained BOOLEAN NOT NULL,
    PRIMARY KEY (scope, operation)
);
CREATE INDEX IF NOT EXISTS chopin_jobs_active ON chopin_jobs(scope, operation) WHERE NOT drained;
CREATE TABLE IF NOT EXISTS chopin_job_output (
    scope UUID NOT NULL,
    operation UUID NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    sealed BYTEA NOT NULL,
    PRIMARY KEY (scope, operation, sequence),
    FOREIGN KEY (scope, operation) REFERENCES chopin_jobs(scope, operation)
);
