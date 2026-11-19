CREATE TABLE chopin_storage_head (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    sequence INTEGER NOT NULL CHECK(sequence>=0),
    digest BLOB NOT NULL CHECK(length(digest)=32),
    identity BLOB NOT NULL CHECK(length(identity)=32),
    schema_digest BLOB NOT NULL CHECK(length(schema_digest)=32),
    epoch INTEGER NOT NULL CHECK(epoch>=0),
    version INTEGER NOT NULL CHECK(version>=0)
) STRICT;
CREATE TABLE chopin_storage_nodes (
    epoch INTEGER NOT NULL,
    key BLOB NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY(epoch,key)
) STRICT, WITHOUT ROWID;
CREATE TABLE chopin_storage_values (
    epoch INTEGER NOT NULL,
    key BLOB NOT NULL CHECK(length(key)=32),
    version INTEGER NOT NULL CHECK(version>=0),
    value BLOB NOT NULL,
    PRIMARY KEY(epoch,key)
) STRICT, WITHOUT ROWID;
