use std::{num::NonZeroUsize, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::HeaderMap,
    middleware,
    routing::put,
};
use uuid::Uuid;

use super::LocalWorker;
use crate::{
    Credential, Error, JobId, Result, WorkerLookup, WorkerObservation, WorkerStart,
    transport::{bearer, decode, no_store},
};

struct Routes {
    worker: Arc<LocalWorker>,
    credential: Credential,
    maximum: NonZeroUsize,
}
impl Routes {
    fn authorize(&self, headers: &HeaderMap) -> Result<()> {
        let supplied =
            Credential::new(bearer(headers)?.to_owned()).map_err(|_| Error::Unauthorized)?;
        if supplied != self.credential {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}
impl LocalWorker {
    /// Mount private control routes under host-owned TLS and networking.
    /// The dedicated registration credential is not an engine or user-facing token.
    pub fn router(self: Arc<Self>, credential: Credential, maximum: NonZeroUsize) -> Router {
        Router::new()
            .route("/{scope}/{operation}", put(admit).get(observe).delete(stop))
            .with_state(Arc::new(Routes {
                worker: self,
                credential,
                maximum,
            }))
            .layer(middleware::from_fn(no_store))
    }
}
async fn admit(
    State(routes): State<Arc<Routes>>,
    Path((scope, operation)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<WorkerObservation>> {
    routes.authorize(&headers)?;
    let start: WorkerStart = decode(body, routes.maximum.get()).await?;
    if start.id != (JobId { scope, operation }) {
        return Err(Error::Conflict);
    }
    Ok(Json(routes.worker.admit(&start).await?))
}
async fn observe(
    State(routes): State<Arc<Routes>>,
    Path((scope, operation)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<WorkerLookup>> {
    routes.authorize(&headers)?;
    let id = JobId { scope, operation };
    let lookup = match routes.worker.observe(id).await? {
        Some(observation) => WorkerLookup::Found { observation },
        None => WorkerLookup::Absent {
            id,
            worker: routes.worker.worker(),
        },
    };
    Ok(Json(lookup))
}
async fn stop(
    State(routes): State<Arc<Routes>>,
    Path((scope, operation)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<WorkerObservation>> {
    routes.authorize(&headers)?;
    Ok(Json(routes.worker.stop(JobId { scope, operation }).await?))
}
