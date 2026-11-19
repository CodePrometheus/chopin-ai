use std::sync::Arc;

use jmt::{
    JellyfishMerkleIterator, JellyfishMerkleTree, KeyHash, RootHash, SimpleHasher,
    storage::{LeafNode, Node, NodeKey, TreeReader, TreeUpdateBatch},
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::{Error, Result, schema::Schema};

pub(crate) struct Hasher(Sha256);

impl SimpleHasher for Hasher {
    fn new() -> Self {
        Self(Sha256::new())
    }

    fn update(&mut self, data: &[u8]) {
        Digest::update(&mut self.0, data);
    }

    fn finalize(self) -> [u8; 32] {
        self.0.finalize().into()
    }
}

pub(crate) struct Tree<'a> {
    pub connection: &'a Connection,
    pub epoch: i64,
}

impl TreeReader for Tree<'_> {
    fn get_node_option(&self, key: &NodeKey) -> anyhow::Result<Option<Node>> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT value FROM chopin_storage_nodes WHERE epoch=?1 AND key=?2",
                params![self.epoch, borsh::to_vec(key)?],
                |row| row.get(0),
            )
            .optional()?;
        bytes
            .map(|bytes| borsh::from_slice(&bytes).map_err(Into::into))
            .transpose()
    }

    fn get_value_option(&self, max_version: u64, key: KeyHash) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self
            .connection
            .query_row(
                "SELECT value FROM chopin_storage_values WHERE epoch=?1 AND key=?2 AND version<=?3",
                params![self.epoch, key.0.as_slice(), i64::try_from(max_version)?],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn get_rightmost_leaf(&self) -> anyhow::Result<Option<(NodeKey, LeafNode)>> {
        let mut statement = self
            .connection
            .prepare("SELECT key,value FROM chopin_storage_nodes WHERE epoch=?1")?;
        let mut rows = statement.query([self.epoch])?;
        let mut rightmost: Option<(NodeKey, LeafNode)> = None;
        while let Some(row) = rows.next()? {
            let node: Node = borsh::from_slice(&row.get::<_, Vec<u8>>(1)?)?;
            if let Node::Leaf(leaf) = node
                && rightmost
                    .as_ref()
                    .is_none_or(|(_, previous)| leaf.key_hash() > previous.key_hash())
            {
                rightmost = Some((borsh::from_slice(&row.get::<_, Vec<u8>>(0)?)?, leaf));
            }
        }
        Ok(rightmost)
    }
}

impl Tree<'_> {
    pub(crate) fn root(&self, version: u64) -> Result<RootHash> {
        JellyfishMerkleTree::<_, Hasher>::new(self)
            .get_root_hash(version)
            .map_err(Error::Index)
    }

    pub(crate) fn apply(
        &self,
        version: u64,
        changes: impl IntoIterator<Item = (KeyHash, Option<Vec<u8>>)>,
    ) -> Result<RootHash> {
        let (root, batch) = JellyfishMerkleTree::<_, Hasher>::new(self)
            .put_value_set(changes, version)
            .map_err(Error::Index)?;
        self.write(batch)?;
        Ok(root)
    }

    fn write(&self, batch: TreeUpdateBatch) -> Result<()> {
        for (key, node) in batch.node_batch.nodes() {
            self.connection.execute(
                "INSERT INTO chopin_storage_nodes(epoch,key,value) VALUES(?1,?2,?3)",
                params![
                    self.epoch,
                    borsh::to_vec(key).map_err(|error| Error::Index(error.into()))?,
                    borsh::to_vec(node).map_err(|error| Error::Index(error.into()))?
                ],
            )?;
        }
        for ((version, key), value) in batch.node_batch.values() {
            if let Some(value) = value {
                self.connection.execute(
                    "INSERT INTO chopin_storage_values(epoch,key,version,value) VALUES(?1,?2,?3,?4) ON CONFLICT(epoch,key) DO UPDATE SET version=excluded.version,value=excluded.value",
                    params![self.epoch, key.0.as_slice(), as_integer(*version)?, value],
                )?;
            } else {
                self.connection.execute(
                    "DELETE FROM chopin_storage_values WHERE epoch=?1 AND key=?2",
                    params![self.epoch, key.0.as_slice()],
                )?;
            }
        }
        for stale in batch.stale_node_index_batch {
            self.connection.execute(
                "DELETE FROM chopin_storage_nodes WHERE epoch=?1 AND key=?2",
                params![
                    self.epoch,
                    borsh::to_vec(&stale.node_key).map_err(|error| Error::Index(error.into()))?
                ],
            )?;
        }
        Ok(())
    }

    pub(crate) fn verify(&self, version: u64, schema: &Schema) -> Result<()> {
        let tree = JellyfishMerkleTree::<_, Hasher>::new(self);
        let root = tree.get_root_hash(version).map_err(Error::Index)?;
        let mut actual = 0u64;
        schema.rows(self.connection, |key, value| {
            let (stored, proof) = tree.get_with_proof(key, version).map_err(Error::Index)?;
            if stored.as_deref() != Some(value.as_slice()) {
                return Err(Error::Integrity);
            }
            proof
                .verify(root, key, Some(&value))
                .map_err(|_| Error::Integrity)?;
            actual = actual.checked_add(1).ok_or(Error::Integrity)?;
            Ok(())
        })?;
        // The iterator requires Arc; this reader stays on the owning connection thread.
        #[allow(clippy::arc_with_non_send_sync)]
        let reader = Arc::new(Tree {
            connection: self.connection,
            epoch: self.epoch,
        });
        let iterator = JellyfishMerkleIterator::new(reader, version, KeyHash([0; 32]))
            .map_err(Error::Index)?;
        let mut indexed = 0u64;
        for item in iterator {
            item.map_err(Error::Index)?;
            indexed = indexed.checked_add(1).ok_or(Error::Integrity)?;
        }
        if actual != indexed {
            return Err(Error::Integrity);
        }
        Ok(())
    }
}

pub(crate) fn as_integer(value: u64) -> Result<i64> {
    value.try_into().map_err(|_| Error::SequenceExhausted)
}
