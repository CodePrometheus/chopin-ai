//! A real encrypted handshake without a process-global cryptography provider.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chopin_protocol::{ChordClient, TlsConnector};
use futures_util::{SinkExt, StreamExt};
use rcgen::generate_simple_self_signed;
use rustls::{
    ClientConfig, RootCertStore, ServerConfig,
    crypto::{CryptoProvider, ring},
    pki_types::PrivatePkcs8KeyDer,
};
use serde_json::{Value, json};
mod support;
use support::Codec;
use tokio::{net::TcpListener, time::timeout};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

#[tokio::test]
#[expect(
    clippy::result_large_err,
    reason = "The transport callback fixes its HTTP error response type."
)]
async fn server_trust() {
    let metadata: Value = serde_json::from_str(include_str!("../contracts.json")).unwrap();
    let deadline = Duration::from_millis(metadata["callTimeoutMs"].as_u64().unwrap());
    timeout(deadline, async {
        assert!(CryptoProvider::get_default().is_none());
        let generated = generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let certificate = generated.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der());
        let server = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions().unwrap().with_no_client_auth()
            .with_single_cert(vec![certificate.clone()], key.into()).unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(server));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("wss://{}/", listener.local_addr().unwrap());
        let saw_authorization = Arc::new(AtomicBool::new(false));
        let seen = saw_authorization.clone();
        let server = tokio::spawn(async move {
            let (first, _) = listener.accept().await.unwrap();
            assert!(acceptor.accept(first).await.is_err());
            let (second, _) = listener.accept().await.unwrap();
            let tls = acceptor.accept(second).await.unwrap();
            let mut socket = accept_hdr_async(tls, move |request: &Request, response: Response| {
                assert_eq!(request.headers().get("authorization").unwrap(), "Bearer fixture-credential");
                seen.store(true, Ordering::SeqCst);
                Ok(response)
            }).await.unwrap();
            let mut codec = Codec::new();
            let hello = codec.decode(&socket.next().await.unwrap().unwrap().into_data()).await;
            assert_eq!(hello["kind"], "hello");
            let bytes = codec.encode(json!({"kind":"hello","protocol":metadata["linkProtocol"],"incarnation":"00000000-0000-0000-0000-000000000001","calls":256})).await;
            socket.send(Message::Binary(bytes.into())).await.unwrap();
            codec.close().await;
            assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
        });

        assert!(ChordClient::connect(&url, "fixture-credential").await.is_err());
        assert!(!saw_authorization.load(Ordering::SeqCst));
        let mut roots = RootCertStore::empty();
        roots.add(certificate).unwrap();
        let trusted = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        let client = ChordClient::connect_with(&url, "fixture-credential", TlsConnector::Rustls(Arc::new(trusted)), Default::default()).await.unwrap();
        assert!(saw_authorization.load(Ordering::SeqCst));
        client.close().await.unwrap();
        server.await.unwrap();
        assert!(CryptoProvider::get_default().is_none());
    }).await.unwrap();
}
