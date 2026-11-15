use std::{num::NonZeroUsize, sync::Arc};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, Request as HttpRequest, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{Broker, Error, Result, WorkerAction, WorkerEvent};

impl Broker {
    /// Private purpose-authenticated routes, relative to the host's callback mount.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route("/{operation}", put(submit).get(snapshot).delete(stop))
            .route("/{operation}/cancel", post(cancel))
            .route("/{operation}/reconcile", post(reconcile))
            .route("/{operation}/output", get(output))
            .route("/{operation}/worker", post(worker))
            .with_state(self)
            .layer(middleware::from_fn(no_store))
    }
}

async fn submit(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    let request = decode(body, broker.settings().max_body_bytes).await?;
    Ok(Json(broker.submit(&caller, operation, &request).await?))
}
async fn cancel(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    let request = decode(body, broker.settings().max_body_bytes).await?;
    Ok(Json(broker.cancel(&caller, operation, &request).await?))
}
async fn snapshot(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    Ok(Json(broker.get(&caller, operation).await?))
}
async fn stop(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    Ok(Json(broker.stop(&caller, operation).await?))
}
async fn reconcile(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    Ok(Json(broker.reconcile(&caller, operation).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputQuery {
    limit: NonZeroUsize,
    cursor: Option<String>,
}
async fn output(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    Query(query): Query<OutputQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let caller = broker.authority().authenticate(bearer(&headers)?).await?;
    Ok(Json(
        broker
            .output(&caller, operation, query.cursor.as_deref(), query.limit)
            .await?,
    ))
}

async fn worker(
    State(broker): State<Arc<Broker>>,
    Path(operation): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> Result<impl IntoResponse> {
    let caller = broker
        .authority()
        .authenticate_worker(bearer(&headers)?)
        .await?;
    if caller.operation != operation {
        return Err(Error::Forbidden);
    }
    let mut tx = broker.begin().await?;
    let record = broker.callback_record(&mut tx, &caller).await?;
    broker
        .authority()
        .authorize_worker(&mut tx, &caller, record.request(), WorkerAction::Observe)
        .await?;
    let maximum = record.settings().max_body_bytes;
    tx.commit().await?;
    let event: WorkerEvent = decode(body, maximum).await?;
    Ok(Json(broker.worker_event(&caller, event).await?))
}

pub(crate) fn bearer(headers: &HeaderMap) -> Result<&str> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .ok_or(Error::Unauthorized)?
        .to_str()
        .map_err(|_| Error::Unauthorized)?;
    let (scheme, value) = authorization.split_once(' ').ok_or(Error::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(Error::Unauthorized);
    }
    Ok(value)
}
pub(crate) async fn decode<T: DeserializeOwned>(body: Body, maximum: usize) -> Result<T> {
    let bytes = to_bytes(body, maximum).await.map_err(|_| Error::Invalid)?;
    serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)
}
pub(crate) async fn no_store(request: HttpRequest, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Problem {
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, retry_after_ms) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", None),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden", None),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", None),
            Self::Conflict => (StatusCode::CONFLICT, "conflict", None),
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid", None),
            Self::Unavailable { retry_after_ms } => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                Some(retry_after_ms),
            ),
            Self::Durability
            | Self::Ciphertext
            | Self::Randomness
            | Self::Database(_)
            | Self::Json(_)
            | Self::Io(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable", None),
        };
        (
            status,
            Json(Problem {
                code,
                retry_after_ms,
            }),
        )
            .into_response()
    }
}
