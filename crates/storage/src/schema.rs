use crate::{Error, Result};
use jmt::KeyHash;
use rusqlite::{Connection, types::ValueRef};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) const PREFIX: &str = "chopin_storage_";

#[derive(Debug)]
pub(crate) struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub primary: Vec<usize>,
}

#[derive(Debug)]
pub(crate) struct Schema {
    pub revision: i64,
    pub digest: [u8; 32],
    pub tables: BTreeMap<String, Table>,
}

impl Schema {
    pub(crate) fn read(connection: &Connection) -> Result<Self> {
        let revision = connection.query_row("PRAGMA schema_version", [], |row| row.get(0))?;
        let mut statement = connection
            .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?;
        let mut rows = statement.query([])?;
        let mut hash = Sha256::new();
        hash.update(b"chopin.storage.schema.v1\0");
        let mut tables = BTreeMap::new();
        while let Some(row) = rows.next()? {
            let kind: String = row.get(0)?;
            let name: String = row.get(1)?;
            let table: String = row.get(2)?;
            if table.starts_with(PREFIX) {
                if !matches!(
                    table.as_str(),
                    "chopin_storage_head" | "chopin_storage_nodes" | "chopin_storage_values"
                ) {
                    return Err(Error::UnsupportedSchema);
                }
                continue;
            }
            if name.starts_with("sqlite_") {
                if name == "sqlite_sequence" {
                    return Err(Error::UnsupportedSchema);
                }
                continue;
            }
            for i in 0..4 {
                hash_value(&mut hash, row.get_ref(i)?);
            }
            if kind == "table" {
                let ordinary: bool = connection.query_row(
                    "SELECT type='table' FROM pragma_table_list WHERE schema='main' AND name=?1",
                    [&name],
                    |row| row.get(0),
                )?;
                if !ordinary {
                    return Err(Error::UnsupportedSchema);
                }
                let table = Table::read(connection, name.clone())?;
                tables.insert(name, table);
            }
        }
        Ok(Self {
            revision,
            digest: hash.finalize().into(),
            tables,
        })
    }

    pub(crate) fn rows(
        &self,
        connection: &Connection,
        mut visit: impl FnMut(KeyHash, Vec<u8>) -> Result<()>,
    ) -> Result<()> {
        for table in self.tables.values() {
            let mut statement =
                connection.prepare(&format!("SELECT * FROM {}", identifier(&table.name)))?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let key = table.key(|index| row.get_ref(index))?;
                visit(key, table.digest(row)?)?;
            }
        }
        Ok(())
    }
}

impl Table {
    fn read(connection: &Connection, name: String) -> Result<Self> {
        let mut statement = connection.prepare(
            "SELECT name,type,\"notnull\",pk,hidden FROM pragma_table_xinfo(?1) ORDER BY cid",
        )?;
        let mut rows = statement.query([&name])?;
        let mut columns = Vec::new();
        let mut keys = Vec::new();
        let mut nullable = Vec::new();
        while let Some(row) = rows.next()? {
            if row.get::<_, i64>(4)? != 0 {
                return Err(Error::UnsupportedSchema);
            }
            let index = columns.len();
            columns.push(row.get::<_, String>(0)?);
            let position: u32 = row.get(3)?;
            if position > 0 {
                keys.push((position, index));
                if !row.get::<_, bool>(2)? {
                    nullable.push((index, row.get::<_, String>(1)?));
                }
            }
        }
        keys.sort_unstable();
        let primary_index: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1) WHERE origin='pk')",
            [&name],
            |row| row.get(0),
        )?;
        if keys.is_empty()
            || (!nullable.is_empty()
                && !(keys.len() == 1
                    && nullable.len() == 1
                    && nullable[0].1.eq_ignore_ascii_case("INTEGER")
                    && !primary_index))
        {
            return Err(Error::UnsupportedSchema);
        }
        Ok(Self {
            name,
            columns,
            primary: keys.into_iter().map(|(_, index)| index).collect(),
        })
    }

    pub(crate) fn key<'a>(
        &self,
        mut value: impl FnMut(usize) -> rusqlite::Result<ValueRef<'a>>,
    ) -> Result<KeyHash> {
        let mut hash = Sha256::new();
        hash.update(b"chopin.storage.key.v1\0");
        hash_value(&mut hash, ValueRef::Text(self.name.as_bytes()));
        for &index in &self.primary {
            let value = value(index)?;
            if matches!(value, ValueRef::Null) {
                return Err(Error::UnsupportedSchema);
            }
            hash_value(&mut hash, value);
        }
        Ok(KeyHash(hash.finalize().into()))
    }

    pub(crate) fn digest(&self, row: &rusqlite::Row<'_>) -> Result<Vec<u8>> {
        let mut hash = Sha256::new();
        hash.update(b"chopin.storage.row.v1\0");
        for index in 0..self.columns.len() {
            hash_value(&mut hash, row.get_ref(index)?);
        }
        Ok(hash.finalize().to_vec())
    }

    pub(crate) fn current(
        &self,
        connection: &Connection,
        values: &[rusqlite::types::Value],
    ) -> Result<Option<Vec<u8>>> {
        let predicate = self
            .primary
            .iter()
            .enumerate()
            .map(|(position, &index)| {
                format!("{}=?{}", identifier(&self.columns[index]), position + 1)
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        let mut statement = connection.prepare(&format!(
            "SELECT * FROM {} WHERE {predicate}",
            identifier(&self.name)
        ))?;
        let mut rows = statement.query(rusqlite::params_from_iter(values))?;
        rows.next()?.map(|row| self.digest(row)).transpose()
    }
}

pub(crate) fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn hash_value(hash: &mut Sha256, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => hash.update([0]),
        ValueRef::Integer(value) => {
            hash.update([1]);
            hash.update(value.to_be_bytes());
        }
        ValueRef::Real(value) => {
            hash.update([2]);
            hash.update(
                (if value == 0.0 { 0.0 } else { value })
                    .to_bits()
                    .to_be_bytes(),
            );
        }
        ValueRef::Text(value) => {
            hash.update([3]);
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        ValueRef::Blob(value) => {
            hash.update([4]);
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
    }
}
