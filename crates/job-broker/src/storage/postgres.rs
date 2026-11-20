use async_trait::async_trait;
use sqlx::PgConnection;
use uuid::Uuid;

use super::{LedgerStorage, SealedRecord};
use crate::{Error, JobId, Result};

#[async_trait]
impl LedgerStorage for PgConnection {
    async fn durable(&mut self) -> Result<()> {
        let (fsync, commit): (String, String) =
            sqlx::query_as("SELECT current_setting('fsync'),current_setting('synchronous_commit')")
                .fetch_one(self)
                .await?;
        if fsync != "on" || !matches!(commit.as_str(), "on" | "remote_apply") {
            return Err(Error::Durability);
        }
        Ok(())
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
             VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(scope,operation) DO NOTHING",
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

    async fn read(&mut self, id: JobId, lock: bool) -> Result<Option<SealedRecord>> {
        let query = if lock {
            "SELECT content,state,revision FROM chopin_jobs WHERE scope=$1 AND operation=$2 FOR UPDATE"
        } else {
            "SELECT content,state,revision FROM chopin_jobs WHERE scope=$1 AND operation=$2"
        };
        Ok(sqlx::query_as(query)
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
            "UPDATE chopin_jobs SET state=$3,revision=$4,drained=$5
             WHERE scope=$1 AND operation=$2 AND revision=$6",
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
            "INSERT INTO chopin_job_output(scope,operation,sequence,sealed) VALUES($1,$2,$3,$4)",
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
            "SELECT sealed FROM chopin_job_output WHERE scope=$1 AND operation=$2 AND sequence=$3",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(sequence)
        .fetch_optional(self)
        .await?)
    }

    async fn has_pending(&mut self, scope: Uuid) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chopin_jobs WHERE scope=$1 AND NOT drained)",
        )
        .bind(scope)
        .fetch_one(self)
        .await?)
    }

    async fn pending(&mut self, scope: Uuid, after: Option<Uuid>, count: i64) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar(
            "SELECT operation FROM chopin_jobs
             WHERE scope=$1 AND NOT drained AND ($2::uuid IS NULL OR operation>$2)
             ORDER BY operation LIMIT $3",
        )
        .bind(scope)
        .bind(after)
        .bind(count)
        .fetch_all(self)
        .await?)
    }
}
