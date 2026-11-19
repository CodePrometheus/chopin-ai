use crate::{Error, Head, Result, content::as_integer};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub(super) struct Metadata {
    pub(super) head: Head,
    pub(super) identity: [u8; 32],
    pub(super) schema: [u8; 32],
    pub(super) epoch: i64,
    pub(super) version: u64,
}

pub(super) fn head(identity: [u8; 32], sequence: u64, schema: [u8; 32], root: [u8; 32]) -> Head {
    let mut hash = Sha256::new();
    hash.update(b"chopin.storage.head.v1\0");
    hash.update(identity);
    hash.update(sequence.to_be_bytes());
    hash.update(schema);
    hash.update(root);
    Head {
        sequence,
        digest: hash.finalize().into(),
    }
}

pub(super) fn save(connection: &Connection, metadata: &Metadata) -> Result<()> {
    connection.execute(
        "INSERT INTO chopin_storage_head(singleton,sequence,digest,identity,schema_digest,epoch,version) VALUES(1,?1,?2,?3,?4,?5,?6) ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest,schema_digest=excluded.schema_digest,epoch=excluded.epoch,version=excluded.version",
        params![as_integer(metadata.head.sequence)?, metadata.head.digest.as_slice(), metadata.identity.as_slice(), metadata.schema.as_slice(), metadata.epoch, as_integer(metadata.version)?],
    )?;
    Ok(())
}

pub(super) fn load(connection: &Connection) -> Result<Metadata> {
    let (sequence, digest, identity, schema, epoch, version): (i64, Vec<u8>, Vec<u8>, Vec<u8>, i64, i64) = connection.query_row(
        "SELECT sequence,digest,identity,schema_digest,epoch,version FROM chopin_storage_head WHERE singleton=1",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    )?;
    if epoch < 0 {
        return Err(Error::Integrity);
    }
    Ok(Metadata {
        head: Head {
            sequence: sequence.try_into().map_err(|_| Error::Integrity)?,
            digest: digest.try_into().map_err(|_| Error::Integrity)?,
        },
        identity: identity.try_into().map_err(|_| Error::Integrity)?,
        schema: schema.try_into().map_err(|_| Error::Integrity)?,
        epoch,
        version: version.try_into().map_err(|_| Error::Integrity)?,
    })
}
