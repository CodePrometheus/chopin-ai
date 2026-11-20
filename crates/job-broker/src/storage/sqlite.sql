CREATE TABLE IF NOT EXISTS chopin_jobs (
    scope BLOB NOT NULL CHECK (length(scope) = 16),
    operation BLOB NOT NULL CHECK (length(operation) = 16),
    content BLOB NOT NULL,
    state BLOB NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    drained INTEGER NOT NULL CHECK (drained IN (0, 1)),
    PRIMARY KEY (scope, operation)
) STRICT;
CREATE INDEX IF NOT EXISTS chopin_jobs_active ON chopin_jobs(scope, operation) WHERE NOT drained;
CREATE TABLE IF NOT EXISTS chopin_job_output (
    scope BLOB NOT NULL,
    operation BLOB NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    sealed BLOB NOT NULL,
    PRIMARY KEY (scope, operation, sequence),
    FOREIGN KEY (scope, operation) REFERENCES chopin_jobs(scope, operation)
) STRICT;
