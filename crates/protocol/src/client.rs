use std::{collections::BTreeMap, sync::Arc};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};

use crate::{
    ProtocolError, Result, StateObserver, TransportError,
    observation::ObservationState,
    wire::{self, Frame, MAX_SAFE_INTEGER, Outgoing, PROTOCOL_VERSION},
};

/// Explicit receive policy; deadlines and reconnection belong to the caller.
#[derive(Clone, Debug)]
pub struct ConnectionOptions {
    /// WebSocket bounds, buffers, and masking policy.
    pub websocket: WebSocketConfig,
    /// Maximum wire bytes per part; `None` explicitly permits unbounded parts.
    pub max_part_size: Option<usize>,
    /// Maximum decoded bytes per part; `None` explicitly permits unbounded payloads.
    pub max_decoded_payload_size: Option<usize>,
}

impl Default for ConnectionOptions {
    /// Uses the producer's untrusted-link part bounds and the transport's message bound.
    fn default() -> Self {
        let websocket = WebSocketConfig::default();
        Self {
            max_part_size: Some(wire::MAX_PART),
            max_decoded_payload_size: Some(wire::MAX_DECODED),
            websocket,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contracts {
    link_protocol: u64,
    contracts: BTreeMap<String, Contract>,
}

/// A sequential authenticated connection that never replays application calls.
///
/// Cancelling an operation makes the connection unusable for further operations.
/// Dropping or closing it releases observations, but does not stop remote goals.
pub struct ChordClient {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    contracts: BTreeMap<String, Contract>,
    options: ConnectionOptions,
    next_id: u64,
    ready: bool,
}

impl std::fmt::Debug for ChordClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChordClient")
            .field("ready", &self.ready)
            .finish_non_exhaustive()
    }
}

impl ChordClient {
    /// Connects with the system-independent public root set and an explicit TLS provider.
    pub async fn connect(url: &str, bearer: &str) -> Result<Self> {
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| ProtocolError::Transport(TransportError { status: None }))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Self::connect_with(
            url,
            bearer,
            Connector::Rustls(Arc::new(tls)),
            ConnectionOptions::default(),
        )
        .await
    }

    /// Connects with explicit transport policy, without storing the bearer or address.
    pub async fn connect_with(
        url: &str,
        bearer: &str,
        connector: Connector,
        options: ConnectionOptions,
    ) -> Result<Self> {
        let contracts: Contracts = serde_json::from_str(include_str!("../contracts.json"))?;
        if contracts.link_protocol != PROTOCOL_VERSION {
            return Err(ProtocolError::InvalidFrame);
        }
        let mut request = url.into_client_request()?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {bearer}"))
            .map_err(|_| ProtocolError::Transport(TransportError { status: None }))?;
        authorization.set_sensitive(true);
        request.headers_mut().insert("authorization", authorization);
        let (socket, _) =
            connect_async_tls_with_config(request, Some(options.websocket), false, Some(connector))
                .await?;
        let mut client = Self {
            socket,
            contracts: contracts.contracts,
            options,
            next_id: 1,
            ready: false,
        };
        client
            .send(Outgoing::Hello {
                incarnation: uuid::Uuid::new_v4(),
            })
            .await?;
        match client.receive().await? {
            Frame::Hello {
                protocol: PROTOCOL_VERSION,
                ..
            } => {}
            _ => return Err(ProtocolError::InvalidFrame),
        }
        client.ready = true;
        Ok(client)
    }

    /// Invokes one declared method and releases its reference after a complete response.
    ///
    /// `None` omits arguments; `Some(Value::Null)` sends an explicit JSON null.
    pub async fn invoke(
        &mut self,
        contract: &str,
        input: Value,
        member: &str,
        args: Option<Value>,
    ) -> Result<Value> {
        if !self
            .token(contract)?
            .variants
            .iter()
            .any(|variant| variant.methods.iter().any(|name| name == member))
        {
            return Err(ProtocolError::UnknownMember);
        }
        self.begin()?;
        let mut state = self.hold(contract, input).await?;
        let method = match state.method(member) {
            Some(index) => index,
            None => {
                self.release(state.id()).await?;
                self.finish();
                return Err(ProtocolError::UnknownMember);
            }
        };
        let call = self.identifier()?;
        self.send(Outgoing::Call {
            call,
            hold: state.id(),
            method,
            args: args.as_ref(),
        })
        .await?;
        let result = loop {
            match self.receive().await? {
                Frame::Result {
                    call: received,
                    value,
                } if received == call => break Ok(value.unwrap_or(Value::Null)),
                Frame::Error {
                    call: received,
                    error,
                } if received == call => break Err(remote_error(member, error)),
                frame => {
                    let batch = state.apply(frame, &mut Default::default())?;
                    if batch {
                        self.acknowledge().await?;
                    }
                }
            }
        };
        self.release(state.id()).await?;
        self.finish();
        result
    }

    /// Reads a complete state unit and releases it; the result is not a persisted execution cursor.
    pub async fn state_snapshot(&mut self, contract: &str, input: Value) -> Result<Value> {
        self.begin()?;
        let state = self.hold(contract, input).await?;
        self.release(state.id()).await?;
        self.finish();
        Ok(state.into_value())
    }

    /// Transfers this connection to one snapshot-plus-delta observation.
    pub async fn observe(mut self, contract: &str, input: Value) -> Result<StateObserver> {
        self.begin()?;
        let state = self.hold(contract, input).await?;
        self.finish();
        Ok(StateObserver::new(self, state))
    }

    /// Closes only the connection. No execution stop or cancellation command is sent.
    pub async fn close(mut self) -> Result<()> {
        self.ready = false;
        self.socket.close(None).await?;
        Ok(())
    }

    pub(crate) fn begin(&mut self) -> Result<()> {
        if !self.ready {
            return Err(ProtocolError::Interrupted);
        }
        self.ready = false;
        Ok(())
    }

    pub(crate) fn finish(&mut self) {
        self.ready = true;
    }

    fn identifier(&mut self) -> Result<u64> {
        if self.next_id > MAX_SAFE_INTEGER {
            return Err(ProtocolError::InvalidFrame);
        }
        let id = self.next_id;
        self.next_id += 1;
        Ok(id)
    }

    fn token(&self, contract: &str) -> Result<&Contract> {
        self.contracts
            .get(contract)
            .ok_or(ProtocolError::UnknownMember)
    }

    async fn hold(&mut self, name: &str, input: Value) -> Result<ObservationState> {
        let contract = self.token(name)?.clone();
        let id = self.identifier()?;
        self.send(Outgoing::Hold {
            hold: id,
            name,
            version: contract.version,
            fingerprint: &contract.fingerprint,
            params: &input,
            address: &contract.address,
        })
        .await?;
        loop {
            match self.receive().await? {
                Frame::Bound { holds } => {
                    let mut bound = None;
                    for binding in holds {
                        if binding.hold > id || (binding.hold == id && bound.is_some()) {
                            return Err(ProtocolError::InvalidFrame);
                        }
                        if binding.hold == id {
                            bound = Some(binding);
                        }
                    }
                    let state = bound
                        .map(|binding| ObservationState::new(contract.clone(), binding))
                        .transpose()?;
                    self.acknowledge().await?;
                    if let Some(state) = state {
                        return Ok(state);
                    }
                }
                Frame::Loading { hold } if hold <= id => {}
                Frame::Gone { hold, error }
                | Frame::Failed {
                    hold,
                    cause: wire::Cause { error, .. },
                    ..
                } if hold == id => return Err(remote_error("hold", error)),
                Frame::Gone { hold, .. } | Frame::Failed { hold, .. } if hold < id => {}
                Frame::State { holds } if holds.iter().all(|change| change.hold < id) => {
                    self.acknowledge().await?
                }
                _ => return Err(ProtocolError::InvalidFrame),
            }
        }
    }

    pub(crate) async fn release(&mut self, hold: u64) -> Result<()> {
        self.send(Outgoing::Release { hold }).await
    }

    async fn send(&mut self, frame: Outgoing<'_>) -> Result<()> {
        self.socket
            .send(Message::Binary(wire::encode(frame)?.into()))
            .await?;
        Ok(())
    }

    pub(crate) async fn acknowledge(&mut self) -> Result<()> {
        self.send(Outgoing::Ack).await
    }

    pub(crate) async fn receive(&mut self) -> Result<Frame> {
        loop {
            let message = self.socket.next().await.ok_or(ProtocolError::Closed)??;
            let frame = match message {
                Message::Binary(bytes) => wire::binary(
                    &bytes,
                    self.options.max_part_size,
                    self.options.max_decoded_payload_size,
                )?,
                Message::Ping(_) => {
                    self.socket.flush().await?;
                    continue;
                }
                Message::Pong(_) => continue,
                Message::Close(_) => return Err(ProtocolError::Closed),
                _ => return Err(ProtocolError::InvalidFrame),
            };
            match frame {
                Frame::Ping => self.send(Outgoing::Pong).await?,
                Frame::Pong => {}
                frame => return Ok(frame),
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Contract {
    pub version: u64,
    pub fingerprint: String,
    pub address: Value,
    pub variants: Vec<Variant>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Variant {
    pub state: Vec<String>,
    pub methods: Vec<String>,
}

pub(crate) fn remote_error(member: &str, wire: Value) -> ProtocolError {
    let error = if wire["kind"] == "chord" {
        wire["error"].clone()
    } else {
        wire
    };
    ProtocolError::Method {
        member: member.into(),
        error,
    }
}
