//! Real encrypted-file and transactional-content checks.
#![allow(clippy::unwrap_used)]

use std::{fs, path::PathBuf};

use chopin_storage::{Database, Error, Head, Options};
use rusqlite::{Connection, types::Value};
use uuid::Uuid;

fn path() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("chopin-storage-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    directory.join("execution.sqlite")
}

fn fixture() -> (PathBuf, Database) {
    let path = path();
    let mut database = Database::create(&path, &[23; 32], &Options::default()).unwrap();
    let mut transaction = database.begin().unwrap();
    transaction
        .exec("CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT NOT NULL, bytes BLOB) STRICT")
        .unwrap();
    transaction.prepare().unwrap();
    transaction.commit().unwrap();
    (path, database)
}

fn insert(database: &mut Database, id: i64, body: &str) -> Head {
    let mut transaction = database.begin().unwrap();
    transaction
        .run(
            "INSERT INTO records(id,body) VALUES(?1,?2)",
            &[id.into(), body.to_owned().into()],
        )
        .unwrap();
    transaction.prepare().unwrap();
    transaction.commit().unwrap()
}

#[test]
fn encrypted_round_trip() {
    let (path, mut database) = fixture();
    let mut transaction = database.begin().unwrap();
    transaction
        .run(
            "INSERT INTO records VALUES(?1,?2,?3)",
            &[
                i64::MAX.into(),
                "snow flower 🌸 é".to_owned().into(),
                Value::Blob(vec![0, 255, 1]),
            ],
        )
        .unwrap();
    let prepared = transaction.prepare().unwrap();
    assert_ne!(prepared.previous, prepared.next);
    assert_eq!(transaction.prepare().unwrap(), prepared);
    assert!(transaction.run("DELETE FROM records", &[]).is_err());
    assert_eq!(transaction.commit().unwrap(), prepared.next);
    database.close().unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"));
    assert!(
        !bytes
            .windows(b"snow flower".len())
            .any(|bytes| bytes == b"snow flower")
    );
    let database = Database::open(&path, &[23; 32], &Options::default()).unwrap();
    assert_eq!(database.head().unwrap(), prepared.next);
    assert_eq!(
        database.query("SELECT * FROM records", &[]).unwrap().values,
        vec![vec![
            i64::MAX.into(),
            "snow flower 🌸 é".to_owned().into(),
            Value::Blob(vec![0, 255, 1])
        ]]
    );
    database.close().unwrap();
}

#[test]
fn writer_exclusion() {
    let (path, database) = fixture();
    assert!(matches!(
        Database::open(&path, &[23; 32], &Options::default()),
        Err(Error::WriterBusy)
    ));
    database.close().unwrap();
    Database::open(&path, &[23; 32], &Options::default())
        .unwrap()
        .close()
        .unwrap();
}

#[test]
fn invalid_store_open() {
    let (path, database) = fixture();
    database.close().unwrap();
    assert!(Database::open(&path, &[24; 32], &Options::default()).is_err());
    let missing = path.with_file_name("missing.sqlite");
    assert!(Database::open(&missing, &[23; 32], &Options::default()).is_err());
    assert!(!missing.exists());
    assert!(Database::create(&path, &[23; 32], &Options::default()).is_err());
}

#[test]
fn prepared_rollback() {
    let (path, mut database) = fixture();
    let before = database.head().unwrap();
    {
        let mut transaction = database.begin().unwrap();
        transaction
            .run("INSERT INTO records VALUES(1,'discarded',NULL)", &[])
            .unwrap();
        transaction.prepare().unwrap();
    }
    assert_eq!(database.head().unwrap(), before);
    assert!(
        database
            .query("SELECT * FROM records", &[])
            .unwrap()
            .values
            .is_empty()
    );
    let after = insert(&mut database, 2, "retained");
    database.close().unwrap();
    assert_eq!(
        Database::open(&path, &[23; 32], &Options::default())
            .unwrap()
            .head()
            .unwrap(),
        after
    );
}

#[test]
fn mutations_and_schema_changes() {
    let (path, mut database) = fixture();
    insert(&mut database, 1, "first");
    insert(&mut database, 2, "second");
    let mut transaction = database.begin().unwrap();
    transaction
        .run("UPDATE records SET id=3,body='moved' WHERE id=1", &[])
        .unwrap();
    transaction
        .run("DELETE FROM records WHERE id=2", &[])
        .unwrap();
    transaction.prepare().unwrap();
    transaction.commit().unwrap();
    database.close().unwrap();
    let mut database = Database::open(&path, &[23; 32], &Options::default()).unwrap();
    assert_eq!(
        database
            .query("SELECT id,body FROM records", &[])
            .unwrap()
            .values,
        vec![vec![3.into(), "moved".to_owned().into()]]
    );
    let mut transaction = database.begin().unwrap();
    transaction
        .exec("ALTER TABLE records ADD COLUMN extra TEXT; CREATE INDEX by_body ON records(body)")
        .unwrap();
    transaction
        .run("UPDATE records SET extra='new field'", &[])
        .unwrap();
    transaction.prepare().unwrap();
    let expected = transaction.commit().unwrap();
    database.close().unwrap();
    assert_eq!(
        Database::open(&path, &[23; 32], &Options::default())
            .unwrap()
            .head()
            .unwrap(),
        expected
    );
}

#[test]
fn composite_keys_and_triggers() {
    let (path, mut database) = fixture();
    let mut transaction = database.begin().unwrap();
    transaction.exec("CREATE TABLE revisions(id INTEGER NOT NULL,version INTEGER NOT NULL,body TEXT,PRIMARY KEY(id,version)) STRICT; CREATE TRIGGER keep_revision AFTER INSERT ON records BEGIN INSERT INTO revisions VALUES(new.id,1,new.body); END").unwrap();
    transaction.prepare().unwrap();
    transaction.commit().unwrap();
    insert(&mut database, 1, "original");
    let mut transaction = database.begin().unwrap();
    transaction
        .run("UPDATE revisions SET body='updated' WHERE id=1", &[])
        .unwrap();
    transaction.prepare().unwrap();
    let expected = transaction.commit().unwrap();
    database.close().unwrap();
    let database = Database::open(&path, &[23; 32], &Options::default()).unwrap();
    assert_eq!(database.head().unwrap(), expected);
    assert_eq!(
        database
            .query("SELECT body FROM revisions", &[])
            .unwrap()
            .values,
        vec![vec!["updated".to_owned().into()]]
    );
}

#[test]
fn unsupported_schema() {
    for ddl in [
        "CREATE TABLE untracked(value TEXT)",
        "CREATE TABLE untracked(id TEXT PRIMARY KEY,value TEXT)",
        "CREATE TABLE untracked(id INTEGER PRIMARY KEY DESC,value TEXT)",
        "CREATE TABLE untracked(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT)",
    ] {
        let (_, mut database) = fixture();
        let before = database.head().unwrap();
        let mut transaction = database.begin().unwrap();
        transaction.exec(ddl).unwrap();
        assert!(
            matches!(transaction.prepare(), Err(Error::UnsupportedSchema)),
            "{ddl}"
        );
        assert!(transaction.prepare().is_err());
        transaction.rollback().unwrap();
        assert_eq!(database.head().unwrap(), before);
        insert(&mut database, 1, "still writable");
    }
}

#[test]
fn sql_boundary() {
    let (_, mut database) = fixture();
    assert!(database.query("DELETE FROM records", &[]).is_err());
    for sql in [
        "COMMIT",
        "PRAGMA synchronous=OFF",
        "DELETE FROM chopin_storage_head",
        "ATTACH ':memory:' AS extra",
        "CREATE TABLE chopin_storage_hidden(id INTEGER PRIMARY KEY)",
    ] {
        let transaction = database.begin().unwrap();
        assert!(transaction.exec(sql).is_err(), "{sql}");
        transaction.rollback().unwrap();
    }
    insert(&mut database, 1, "not bypassed");
}

#[test]
fn authenticated_content() {
    for sql in [
        "UPDATE records SET body='changed' WHERE id=1",
        "DELETE FROM records WHERE id=1",
        "INSERT INTO records VALUES(2,'extra',NULL)",
    ] {
        let (path, mut database) = fixture();
        insert(&mut database, 1, "original");
        database.close().unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "key", format!("x'{}'", "17".repeat(32)))
            .unwrap();
        connection.execute(sql, []).unwrap();
        connection.close().unwrap();
        assert!(
            Database::open(&path, &[23; 32], &Options::default()).is_err(),
            "{sql}"
        );
    }
}

#[test]
fn unchanged_transactions() {
    let (_, mut database) = fixture();
    insert(&mut database, 1, "stable");
    let before = database.head().unwrap();
    let mut transaction = database.begin().unwrap();
    transaction
        .run("UPDATE records SET body='stable' WHERE id=1", &[])
        .unwrap();
    assert_eq!(transaction.prepare().unwrap().next, before);
    assert_eq!(transaction.commit().unwrap(), before);
}

#[test]
fn initialization_reconciliation() {
    let path = path();
    fs::File::create(&path).unwrap().sync_all().unwrap();
    assert!(Database::open(&path, &[23; 32], &Options::default()).is_err());
    let mut database = Database::initialize(&path, &[23; 32], &Options::default()).unwrap();
    assert_eq!(database.head().unwrap().sequence, 0);
    let mut transaction = database.begin().unwrap();
    transaction
        .exec("CREATE TABLE records(id INTEGER PRIMARY KEY,body TEXT NOT NULL) STRICT")
        .unwrap();
    transaction.prepare().unwrap();
    transaction.commit().unwrap();
    let expected = insert(&mut database, 1, "preserved initialization");
    database.close().unwrap();
    let database = Database::initialize(&path, &[23; 32], &Options::default()).unwrap();
    assert_eq!(database.head().unwrap(), expected);
    assert_eq!(
        database
            .query("SELECT body FROM records", &[])
            .unwrap()
            .values,
        vec![vec!["preserved initialization".to_owned().into()]]
    );
}

#[test]
fn foreign_database_preservation() {
    let path = path();
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "key", format!("x'{}'", "17".repeat(32)))
        .unwrap();
    connection.execute_batch("CREATE TABLE foreign_records(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO foreign_records VALUES(1,'original')").unwrap();
    connection.close().unwrap();
    assert!(Database::initialize(&path, &[23; 32], &Options::default()).is_err());
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "key", format!("x'{}'", "17".repeat(32)))
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT body FROM foreign_records", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "original"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='chopin_storage_head'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
