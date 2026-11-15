use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub(crate) struct Codec {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}
impl Codec {
    pub(crate) fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let mut child = Command::new("node")
            .arg(root.join("packages/harness-pi/tests/fixtures/codec-oracle.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            output,
        }
    }
    async fn exchange(&mut self, request: Value) -> Value {
        self.input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        self.input.flush().await.unwrap();
        serde_json::from_str(
            &self
                .output
                .next_line()
                .await
                .unwrap()
                .expect("official codec exited"),
        )
        .unwrap()
    }
    pub(crate) async fn encode(&mut self, frame: Value) -> Vec<u8> {
        serde_json::from_value(self.exchange(json!({"op":"encode","frame":frame})).await).unwrap()
    }
    pub(crate) async fn decode(&mut self, bytes: &[u8]) -> Value {
        self.exchange(json!({"op":"decode","bytes":bytes})).await
    }
    pub(crate) async fn close(mut self) {
        self.input.shutdown().await.unwrap();
        drop(self.input);
        assert!(self.child.wait().await.unwrap().success());
    }
}
