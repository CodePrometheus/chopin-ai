//! Fault injection uses real connections and the producer's binary codec.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod support;

use chopin_protocol::{ChordClient, ProtocolError};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{future::Future, time::Duration};
use support::Codec;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

struct Peer {
    socket: WebSocketStream<TcpStream>,
    codec: Codec,
}
fn metadata() -> Value {
    serde_json::from_str(include_str!("../contracts.json")).unwrap()
}
fn deadline() -> Duration {
    Duration::from_millis(metadata()["callTimeoutMs"].as_u64().unwrap())
}

async fn peer<F, T>(script: F) -> (String, JoinHandle<()>)
where
    F: FnOnce(Peer) -> T + Send + 'static,
    T: Future<Output = ()> + Send,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        script(Peer {
            socket: accept_async(stream).await.unwrap(),
            codec: Codec::new(),
        })
        .await;
    });
    (url, task)
}
async fn receive(peer: &mut Peer) -> Value {
    let bytes = peer.socket.next().await.unwrap().unwrap().into_data();
    peer.codec.decode(&bytes).await
}
async fn send(peer: &mut Peer, frame: Value) {
    let bytes = peer.codec.encode(frame).await;
    peer.socket
        .send(Message::Binary(bytes.into()))
        .await
        .unwrap();
}
async fn hello(peer: &mut Peer, protocol: u64) {
    let request = receive(peer).await;
    assert_eq!(request["kind"], "hello");
    assert_eq!(request["protocol"], metadata()["linkProtocol"]);
    send(peer, json!({"kind":"hello","protocol":protocol,"incarnation":"00000000-0000-0000-0000-000000000001","calls":256})).await;
}
async fn handshake(peer: &mut Peer) {
    hello(peer, metadata()["linkProtocol"].as_u64().unwrap()).await;
}
async fn request(peer: &mut Peer) -> (u64, String) {
    let request = receive(peer).await;
    assert_eq!(request["kind"], "hold");
    let name = request["type"].as_str().unwrap().to_owned();
    let contract = &metadata()["contracts"][&name];
    assert_eq!(request["version"], contract["version"]);
    assert_eq!(request["fingerprint"], contract["fingerprint"]);
    assert_eq!(request["address"], contract["address"]);
    (request["hold"].as_u64().unwrap(), name)
}
fn index(contract: &str, field: &str, member: &str) -> usize {
    metadata()["contracts"][contract]["variants"][0][field]
        .as_array()
        .unwrap()
        .iter()
        .position(|name| name == member)
        .unwrap()
}
fn binding(id: u64, contract: &str, values: Value) -> Value {
    let members: Vec<_> = metadata()["contracts"][contract]["variants"][0]["state"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, name)| json!({"member":index,"value":values[name.as_str().unwrap()]}))
        .collect();
    json!({"kind":"bound","holds":[{"hold":id,"variant":0,"members":members,"failed":[]}]})
}
async fn hold(peer: &mut Peer, values: Value) -> (u64, String) {
    let (id, contract) = request(peer).await;
    send(peer, binding(id, &contract, values)).await;
    assert_eq!(receive(peer).await, json!({"kind":"ack"}));
    (id, contract)
}
fn changes(id: u64, members: Value, retired: Value) -> Value {
    json!({"kind":"state","holds":[{"hold":id,"members":members,"failed":[],"retired":retired}]})
}
async fn observe(url: &str) -> chopin_protocol::StateObserver {
    ChordClient::connect(url, "fixture")
        .await
        .unwrap()
        .observe("chopin.conversation", json!({"conversation":1}))
        .await
        .unwrap()
}

#[tokio::test]
async fn protocol_mismatch() {
    timeout(deadline(), async {
        let (url, task) = peer(|mut peer| async move {
            hello(&mut peer, metadata()["linkProtocol"].as_u64().unwrap() + 1).await;
            peer.codec.close().await;
        })
        .await;
        assert!(matches!(
            ChordClient::connect(&url, "fixture").await,
            Err(ProtocolError::InvalidFrame)
        ));
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn incomplete_snapshot() {
    timeout(deadline(), async {
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            let (id, contract) = request(&mut peer).await;
            let mut frame = binding(id, &contract, json!({}));
            frame["holds"][0]["members"].as_array_mut().unwrap().pop();
            send(&mut peer, frame).await;
            peer.codec.close().await;
        })
        .await;
        let client = ChordClient::connect(&url, "fixture").await.unwrap();
        assert!(matches!(
            client
                .observe("chopin.conversation", json!({"conversation":1}))
                .await,
            Err(ProtocolError::InvalidFrame)
        ));
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_delta() {
    timeout(deadline(), async {
        let (advance, ready) = oneshot::channel();
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            let (id, contract) = hold(&mut peer, json!({"view":{"text":"original"}})).await;
            ready.await.unwrap();
            send(&mut peer, changes(id, json!([{"member":index(&contract,"state","view"),"ops":[["s",["text"],"partial"],["a",["missing"],"invalid"]]}]), json!([]))).await;
            peer.codec.close().await;
        }).await;
        let mut observer = observe(&url).await;
        assert_eq!(observer.state().unwrap()["view"]["text"], "original");
        advance.send(()).unwrap();
        assert!(matches!(observer.next().await, Err(ProtocolError::InvalidState)));
        assert!(matches!(observer.state(), Err(ProtocolError::Interrupted)));
        assert!(matches!(observer.next().await, Err(ProtocolError::Interrupted)));
        task.await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn cancelled_read() {
    timeout(deadline(), async {
        let (finish, done) = oneshot::channel();
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            hold(&mut peer, json!({"view":{"text":"retained"}})).await;
            done.await.unwrap();
            peer.codec.close().await;
        })
        .await;
        let mut observer = observe(&url).await;
        {
            let pending = observer.next();
            tokio::pin!(pending);
            assert!(futures_util::poll!(&mut pending).is_pending());
        }
        assert!(matches!(observer.state(), Err(ProtocolError::Interrupted)));
        assert!(matches!(
            observer.next().await,
            Err(ProtocolError::Interrupted)
        ));
        finish.send(()).unwrap();
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn member_dictionaries() {
    timeout(deadline(), async {
        let (advance, ready) = oneshot::channel();
        let (finish, done) = oneshot::channel();
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            let (id, contract) = hold(
                &mut peer,
                json!({"view":{"text":""},"running":{"output":""}}),
            )
            .await;
            ready.await.unwrap();
            let view = index(&contract, "state", "view");
            let running = index(&contract, "state", "running");
            send(
                &mut peer,
                changes(
                    id,
                    json!([
                        {"member":view,"ops":[["#",0,["text"]],["a",0,"first"]]},
                        {"member":running,"ops":[["#",0,["output"]],["a",0,"second"]]}
                    ]),
                    json!([]),
                ),
            )
            .await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"ack"}));
            send(
                &mut peer,
                changes(
                    id,
                    json!([{ "member":view,"ops":[["a",0," third"]] }]),
                    json!([]),
                ),
            )
            .await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"ack"}));
            done.await.unwrap();
            peer.codec.close().await;
        })
        .await;
        let mut observer = observe(&url).await;
        advance.send(()).unwrap();
        let first = observer.next().await.unwrap();
        assert_eq!(first.changed_paths.len(), 2);
        assert_eq!(observer.state().unwrap()["view"]["text"], "first");
        assert_eq!(observer.state().unwrap()["running"]["output"], "second");
        observer.next().await.unwrap();
        assert_eq!(observer.state().unwrap()["view"]["text"], "first third");
        finish.send(()).unwrap();
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn snapshot_epoch() {
    timeout(deadline(), async {
        let (advance, ready) = oneshot::channel();
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            let (id, contract) = hold(&mut peer, json!({"view":{"text":""}})).await;
            ready.await.unwrap();
            let member = index(&contract, "state", "view");
            send(
                &mut peer,
                changes(
                    id,
                    json!([{"member":member,"ops":[["#",0,["text"]],["a",0,"first"]]}]),
                    json!([]),
                ),
            )
            .await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"ack"}));
            send(
                &mut peer,
                binding(id, &contract, json!({"view":{"text":"new"}})),
            )
            .await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"ack"}));
            send(
                &mut peer,
                changes(
                    id,
                    json!([{"member":member,"ops":[["a",0,"stale"]]}]),
                    json!([]),
                ),
            )
            .await;
            peer.codec.close().await;
        })
        .await;
        let mut observer = observe(&url).await;
        advance.send(()).unwrap();
        observer.next().await.unwrap();
        observer.next().await.unwrap();
        assert_eq!(observer.state().unwrap()["view"]["text"], "new");
        assert!(matches!(
            observer.next().await,
            Err(ProtocolError::InvalidState)
        ));
        assert!(observer.state().is_err());
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn mismatched_reply() {
    timeout(deadline(), async {
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            hold(&mut peer, json!({})).await;
            let call = receive(&mut peer).await;
            send(
                &mut peer,
                json!({"kind":"result","call":call["call"].as_u64().unwrap()+1,"value":100}),
            )
            .await;
            peer.codec.close().await;
        })
        .await;
        let mut client = ChordClient::connect(&url, "fixture").await.unwrap();
        assert!(matches!(
            client
                .invoke("chopin.conversations", json!({}), "create", None)
                .await,
            Err(ProtocolError::InvalidFrame)
        ));
        assert!(matches!(
            client
                .invoke("chopin.conversations", json!({}), "create", None)
                .await,
            Err(ProtocolError::Interrupted)
        ));
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn ack_batches() {
    timeout(deadline(), async {
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            let (id, contract) = hold(&mut peer, json!({"view":{"text":"retained"}})).await;
            send(&mut peer, json!({"kind":"ping"})).await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"pong"}));
            send(
                &mut peer,
                changes(id, json!([]), json!([index(&contract, "state", "view")])),
            )
            .await;
            assert_eq!(receive(&mut peer).await, json!({"kind":"ack"}));
            assert_eq!(
                receive(&mut peer).await,
                json!({"kind":"release","hold":id})
            );
            peer.codec.close().await;
        })
        .await;
        let mut observer = observe(&url).await;
        let update = observer.next().await.unwrap();
        assert!(update.changed_paths.is_empty());
        assert_eq!(update.retired_members, vec!["view"]);
        assert_eq!(observer.state().unwrap()["view"]["text"], "retained");
        observer.close().await.unwrap();
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn lost_reply() {
    timeout(deadline(), async {
        let (received, observed) = oneshot::channel();
        let (url, task) = peer(|mut peer| async move {
            handshake(&mut peer).await;
            hold(&mut peer, json!({})).await;
            let call = receive(&mut peer).await;
            assert_eq!(call["kind"], "call");
            received.send(call["method"].clone()).unwrap();
            peer.codec.close().await;
        })
        .await;
        let mut client = ChordClient::connect(&url, "fixture").await.unwrap();
        assert!(matches!(
            client
                .invoke("chopin.conversations", json!({}), "create", None)
                .await,
            Err(ProtocolError::Closed | ProtocolError::Transport(_))
        ));
        assert_eq!(
            observed.await.unwrap(),
            index("chopin.conversations", "methods", "create")
        );
        assert!(matches!(
            client
                .invoke("chopin.conversations", json!({}), "create", None)
                .await,
            Err(ProtocolError::Interrupted)
        ));
        task.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
#[expect(
    clippy::result_large_err,
    reason = "The transport callback fixes its HTTP error response type."
)]
async fn http_rejection() {
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };
    timeout(deadline(), async {
        for status in [401, 403, 404] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}/", listener.local_addr().unwrap());
            let peer = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let rejected =
                    accept_hdr_async(stream, move |_request: &Request, _response: Response| {
                        Err(tokio_tungstenite::tungstenite::http::Response::builder()
                            .status(status)
                            .body(Some("private rejection detail".into()))
                            .unwrap())
                    })
                    .await;
                assert!(rejected.is_err());
            });
            let error = ChordClient::connect(&url, "fixture").await.unwrap_err();
            assert_eq!(error.http_status(), Some(status));
            assert!(!format!("{error:?}").contains("private rejection detail"));
            peer.await.unwrap();
        }
    })
    .await
    .unwrap();
}
