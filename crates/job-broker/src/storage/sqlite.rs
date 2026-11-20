use async_trait::async_trait;
use sqlx::SqliteConnection;
use uuid::Uuid;

use super::{LedgerStorage, SealedRecord};
use crate::{Error, JobId, Result};

pub(super) async fn durable(connection: &mut SqliteConnection) -> Result<()> {
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *connection)
        .await?;
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await?;
    let foreign_keys: bool = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(connection)
        .await?;
    if synchronous < 2 || journal != "wal" || !foreign_keys {
        return Err(Error::Durability);
    }
    Ok(())
}

#[async_trait]
impl LedgerStorage for SqliteConnection {
    async fn durable(&mut self) -> Result<()> {
        durable(self).await
    }

    async fn insert(
        &mut self,
        id: JobId,
        content: Vec<u8>,
        state: Vec<u8>,
        drained: bool,
    ) -> Result<bool> {
        let changed = sqlx::query(
            "INSERT INTO chopin_jobs(scope,operation,content,state,revision,drained)
             VALUES(?1,?2,?3,?4,1,?5) ON CONFLICT(scope,operation) DO NOTHING",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(content)
        .bind(state)
        .bind(drained)
        .execute(self)
        .await?;
        Ok(changed.rows_affected() == 1)
    }

    async fn read(&mut self, id: JobId, _: bool) -> Result<Option<SealedRecord>> {
        Ok(sqlx::query_as(
            "SELECT content,state,revision FROM chopin_jobs WHERE scope=?1 AND operation=?2",
        )
        .bind(id.scope)
        .bind(id.operation)
        .fetch_optional(self)
        .await?)
    }

    async fn update(
        &mut self,
        id: JobId,
        state: Vec<u8>,
        revision: i64,
        drained: bool,
        previous: i64,
    ) -> Result<bool> {
        let changed = sqlx::query(
            "UPDATE chopin_jobs SET state=?3,revision=?4,drained=?5
             WHERE scope=?1 AND operation=?2 AND revision=?6",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(state)
        .bind(revision)
        .bind(drained)
        .bind(previous)
        .execute(self)
        .await?;
        Ok(changed.rows_affected() == 1)
    }

    async fn insert_frame(&mut self, id: JobId, sequence: i64, sealed: Vec<u8>) -> Result<()> {
        sqlx::query(
            "INSERT INTO chopin_job_output(scope,operation,sequence,sealed) VALUES(?1,?2,?3,?4)",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(sequence)
        .bind(sealed)
        .execute(self)
        .await?;
        Ok(())
    }

    async fn frame(&mut self, id: JobId, sequence: i64) -> Result<Option<Vec<u8>>> {
        Ok(sqlx::query_scalar(
            "SELECT sealed FROM chopin_job_output WHERE scope=?1 AND operation=?2 AND sequence=?3",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(sequence)
        .fetch_optional(self)
        .await?)
    }

    async fn has_pending(&mut self, scope: Uuid) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chopin_jobs WHERE scope=?1 AND NOT drained)",
        )
        .bind(scope)
        .fetch_one(self)
        .await?)
    }

    async fn pending(&mut self, scope: Uuid, after: Option<Uuid>, count: i64) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar(
            "SELECT operation FROM chopin_jobs
             WHERE scope=?1 AND NOT drained AND (?2 IS NULL OR operation>?2)
             ORDER BY operation LIMIT ?3",
        )
        .bind(scope)
        .bind(after)
        .bind(count)
        .fetch_all(self)
        .await?)
    }
}
