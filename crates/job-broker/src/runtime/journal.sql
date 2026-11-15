CREATE TABLE worker_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    sealed BLOB NOT NULL
) STRICT;

CREATE TABLE worker_jobs (
    scope BLOB NOT NULL CHECK (length(scope) = 16),
    operation BLOB NOT NULL CHECK (length(operation) = 16),
    revision INTEGER NOT NULL CHECK (revision > 0),
    settled INTEGER NOT NULL CHECK (settled IN (0, 1)),
    sealed BLOB NOT NULL,
    PRIMARY KEY (scope, operation)
) STRICT, WITHOUT ROWID;

CREATE INDEX worker_jobs_pending ON worker_jobs(scope, operation) WHERE settled = 0;
