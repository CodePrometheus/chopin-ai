use std::{
    num::{NonZeroU64, NonZeroUsize},
    sync::Arc,
};

use reqwest::{
    Client, ClientBuilder, Method, StatusCode,
    header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HeaderValue},
};
use serde::{Serialize, de::DeserializeOwned};
use url::Url;
use uuid::Uuid;

use crate::{
    Callback, Caller, Error, JobId, Phase, Request, Result, Snapshot, State, WorkerDirectory,
    WorkerEndpoint, WorkerEvent, WorkerLookup, WorkerObservation, WorkerStart, WorkerTransport,
};

/// Explicit control-transport bounds supplied by the host.
#[derive(Clone, Debug)]
pub struct TransportPolicy {
    /// Maximum bytes consumed from one response, including chunked responses.
    pub response_bytes: NonZeroUsize,
    /// Backoff guidance for an unknown remote outcome, in milliseconds.
    pub retry_after_ms: NonZeroU64,
}

/// Authenticated worker and callback transport, with no redirects or automatic retries.
#[derive(Clone)]
pub struct ControlClient {
    client: Client,
    policy: TransportPolicy,
}
impl std::fmt::Debug for ControlClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlClient")
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}
impl ControlClient {
    /// Keeps host-configured TLS and networking, while forbidding implicit request replay.
    pub fn new(builder: ClientBuilder, policy: TransportPolicy) -> Result<Self> {
        let client = builder
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| Error::Invalid)?;
        Ok(Self { client, policy })
    }

    /// Send one stable worker admission. An error may follow a durably accepted request.
    pub async fn start(
        &self,
        endpoint: &WorkerEndpoint,
        launch: &WorkerStart,
    ) -> Result<WorkerObservation> {
        let observed = self
            .send(
                Method::PUT,
                job_url(endpoint, launch.id)?,
                endpoint.credential().expose(),
                Some(launch),
                false,
            )
            .await?;
        check(endpoint, launch.id, observed)
    }
    /// Look up one original operation. Only a checked `Absent` payload returns `None`.
    pub async fn observe(
        &self,
        endpoint: &WorkerEndpoint,
        id: JobId,
    ) -> Result<Option<WorkerObservation>> {
        let lookup: WorkerLookup = self
            .send::<(), _>(
                Method::GET,
                job_url(endpoint, id)?,
                endpoint.credential().expose(),
                None,
                false,
            )
            .await?;
        match lookup {
            WorkerLookup::Absent {
                id: observed,
                worker,
            } if observed == id && worker == endpoint.worker() => Ok(None),
            WorkerLookup::Absent { .. } => Err(Error::Conflict),
            WorkerLookup::Found { observation } => check(endpoint, id, observation).map(Some),
        }
    }
    /// Persist stop for the original identity, preserving a tombstone against delayed starts.
    pub async fn stop(&self, endpoint: &WorkerEndpoint, id: JobId) -> Result<WorkerObservation> {
        let observed = self
            .send::<(), _>(
                Method::DELETE,
                job_url(endpoint, id)?,
                endpoint.credential().expose(),
                None,
                false,
            )
            .await?;
        check(endpoint, id, observed)
    }
    /// Deliver one original worker fact; only a matching committed snapshot acknowledges it.
    pub async fn event(
        &self,
        callback: &Callback,
        id: JobId,
        worker: Uuid,
        event: &WorkerEvent,
    ) -> Result<Snapshot> {
        let url = Url::parse(&callback.url).map_err(|_| Error::Invalid)?;
        crate::worker::address(url.as_str())?;
        let snapshot: Snapshot = self
            .send(
                Method::POST,
                url,
                callback.credential.expose(),
                Some(event),
                true,
            )
            .await?;
        if snapshot.scope_id != id.scope
            || snapshot.operation_id != id.operation
            || snapshot.state.worker != Some(worker)
        {
            return Err(Error::Conflict);
        }
        if snapshot.state.version == 0 || !acknowledges(event, &snapshot.state) {
            return Err(self.unavailable());
        }
        Ok(snapshot)
    }

    async fn send<B: Serialize, R: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        credential: &str,
        body: Option<&B>,
        callback: bool,
    ) -> Result<R> {
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {credential}")).map_err(|_| Error::Invalid)?;
        authorization.set_sensitive(true);
        let mut request = self
            .client
            .request(method, url)
            .header(CACHE_CONTROL, "no-cache, no-store")
            .header(AUTHORIZATION, authorization);
        if let Some(body) = body {
            request = request
                .header(CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(body)?);
        }
        let mut response = request.send().await.map_err(|_| self.unavailable())?;
        if response.status() != StatusCode::OK {
            return Err(match (callback, response.status()) {
                (true, StatusCode::UNAUTHORIZED) => Error::Unauthorized,
                (true, StatusCode::FORBIDDEN) => Error::Forbidden,
                (true, StatusCode::CONFLICT) => Error::Conflict,
                _ => self.unavailable(),
            });
        }
        let maximum = self.policy.response_bytes.get();
        if response
            .content_length()
            .is_some_and(|length| length > maximum as u64)
        {
            return Err(self.unavailable());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| self.unavailable())? {
            if body
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > maximum)
            {
                return Err(self.unavailable());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| self.unavailable())
    }
    fn unavailable(&self) -> Error {
        Error::Unavailable {
            retry_after_ms: self.policy.retry_after_ms.get(),
        }
    }
}

/// Combines host-owned placement with the shared authenticated transport.
#[derive(Clone)]
pub struct HttpWorkerTransport {
    directory: Arc<dyn WorkerDirectory>,
    client: ControlClient,
}
impl std::fmt::Debug for HttpWorkerTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpWorkerTransport")
            .field("client", &self.client)
            .finish_non_exhaustive()
    }
}
impl HttpWorkerTransport {
    /// Uses a directory that preserves original resource binding across configuration changes.
    pub fn new(directory: Arc<dyn WorkerDirectory>, client: ControlClient) -> Self {
        Self { directory, client }
    }
}
#[async_trait::async_trait]
impl WorkerTransport for HttpWorkerTransport {
    async fn locate(
        &self,
        caller: &Caller,
        request: &Request,
        expected: Option<Uuid>,
    ) -> Result<WorkerEndpoint> {
        self.directory.locate(caller, request, expected).await
    }
    async fn start(
        &self,
        endpoint: &WorkerEndpoint,
        launch: &WorkerStart,
    ) -> Result<WorkerObservation> {
        self.client.start(endpoint, launch).await
    }
    async fn observe(
        &self,
        endpoint: &WorkerEndpoint,
        id: JobId,
    ) -> Result<Option<WorkerObservation>> {
        self.client.observe(endpoint, id).await
    }
    async fn stop(&self, endpoint: &WorkerEndpoint, id: JobId) -> Result<WorkerObservation> {
        self.client.stop(endpoint, id).await
    }
}
fn job_url(endpoint: &WorkerEndpoint, id: JobId) -> Result<Url> {
    if id.scope.is_nil() || id.operation.is_nil() {
        return Err(Error::Invalid);
    }
    endpoint
        .url()
        .join(&format!("{}/{}", id.scope, id.operation))
        .map_err(|_| Error::Invalid)
}
fn check(
    endpoint: &WorkerEndpoint,
    id: JobId,
    observed: WorkerObservation,
) -> Result<WorkerObservation> {
    if observed.id != id || observed.worker != endpoint.worker() {
        return Err(Error::Conflict);
    }
    Ok(observed)
}

fn acknowledges(event: &WorkerEvent, state: &State) -> bool {
    match event {
        WorkerEvent::Read => true,
        WorkerEvent::Attached { process } => state.process.as_ref() == Some(process),
        WorkerEvent::Release => state.released,
        WorkerEvent::Started => state.started,
        WorkerEvent::NotStarted => {
            state.phase == Phase::Drained
                && state.process.is_none()
                && !state.released
                && state.stop_requested
                && state.output_complete
        }
        WorkerEvent::Output { sequence, .. } => state.last_sequence >= *sequence,
        WorkerEvent::Exited { exit } => state.primary_exit.as_ref() == Some(exit),
        WorkerEvent::OutputComplete { sequence } => {
            state.output_complete && state.last_sequence == *sequence
        }
        WorkerEvent::Drained { process, sequence } => {
            state.phase == Phase::Drained
                && state.process.as_ref() == Some(process)
                && state.output_complete
                && state.last_sequence == *sequence
        }
    }
}
