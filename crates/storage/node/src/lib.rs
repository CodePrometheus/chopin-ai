//! Generated runtime bindings; handwritten code contains no unsafe operations.

use std::{num::NonZeroU32, path::PathBuf, time::Duration};

use napi::{
    Env,
    bindgen_prelude::{BigInt, Buffer, Either5, Null, PromiseRaw},
};
use napi_derive::napi;
use rusqlite::types::Value;
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

use chopin_storage::{Database, Head, Options, Prepared, Rows, Transaction};

type SqlValue = Either5<Null, f64, BigInt, String, Buffer>;

#[napi(object)]
/// Trusted host tuning passed to one native connection.
pub struct NativeOptions {
    /// Requests queued before asynchronous backpressure applies.
    pub queue_capacity: u32,
    /// Optional pager cache budget in kibibytes.
    pub cache_kib: Option<u32>,
    /// Optional database lock wait in milliseconds.
    pub busy_timeout_ms: Option<u32>,
}

#[napi(object)]
/// Exact local content commitment returned across the runtime boundary.
pub struct NativeHead {
    /// Commit sequence without floating point conversion.
    pub sequence: BigInt,
    /// Authenticated content digest.
    pub digest: Buffer,
}

#[napi(object)]
/// Owned operation output; absent fields do not assert a successful mutation.
pub struct NativeResult {
    /// Current or prepared successor head.
    pub head: Option<NativeHead>,
    /// Predecessor of a prepared transaction.
    pub previous: Option<NativeHead>,
    /// Query column names in result order.
    pub columns: Vec<String>,
    /// Actual query values, preserving exact integers and binary content.
    pub rows: Vec<Vec<SqlValue>>,
    /// Actual affected row count.
    pub changes: Option<BigInt>,
}

enum Output {
    Empty,
    Head(Head),
    Prepared(Prepared),
    Rows(Rows),
    Changed(u64),
}

enum Operation {
    Begin,
    Exec(String),
    Run(String, Vec<Value>),
    Query(String, Vec<Value>),
    Prepare,
    Commit,
    Rollback,
    Head,
    Close,
}

enum OpenMode {
    Existing,
    Create,
    Initialize,
}

struct Request {
    operation: Operation,
    result: oneshot::Sender<std::result::Result<Output, String>>,
}

/// An asynchronous handle; SQL and hashing execute only on its dedicated thread.
#[napi]
pub struct NativeConnection {
    sender: mpsc::Sender<Request>,
}

#[napi]
impl NativeConnection {
    /// Copies caller-owned binary values before asynchronous dispatch.
    #[napi]
    pub fn request<'env>(
        &self,
        env: &'env Env,
        operation: String,
        sql: Option<String>,
        values: Vec<SqlValue>,
    ) -> napi::Result<PromiseRaw<'env, NativeResult>> {
        let sql = || {
            sql.clone()
                .ok_or_else(|| invalid("a SQL statement is required"))
        };
        let operation = match operation.as_str() {
            "begin" => Operation::Begin,
            "exec" => Operation::Exec(sql()?),
            "run" => Operation::Run(sql()?, decode(values)?),
            "query" => Operation::Query(sql()?, decode(values)?),
            "prepare" => Operation::Prepare,
            "commit" => Operation::Commit,
            "rollback" => Operation::Rollback,
            "head" => Operation::Head,
            "close" => Operation::Close,
            _ => return Err(invalid("unknown execution storage operation")),
        };
        let sender = self.sender.clone();
        env.spawn_future(async move {
            let (result, receiver) = oneshot::channel();
            sender
                .send(Request { operation, result })
                .await
                .map_err(|_| failed("the execution storage thread is closed"))?;
            let output = receiver
                .await
                .map_err(|_| {
                    failed("the execution storage thread stopped before returning a result")
                })?
                .map_err(failed)?;
            Ok(encode(output))
        })
    }
}

#[napi]
/// Copies the key before starting an exclusive storage thread and resolves after verification.
pub fn open_native_store<'env>(
    env: &'env Env,
    path: String,
    key: Buffer,
    create: bool,
    options: NativeOptions,
) -> napi::Result<PromiseRaw<'env, NativeConnection>> {
    start(
        env,
        path,
        key,
        if create {
            OpenMode::Create
        } else {
            OpenMode::Existing
        },
        options,
    )
}

/// Continues an explicitly authorized initializer; existing nonempty data is verified rather than reset.
#[napi]
pub fn initialize_native_store<'env>(
    env: &'env Env,
    path: String,
    key: Buffer,
    options: NativeOptions,
) -> napi::Result<PromiseRaw<'env, NativeConnection>> {
    start(env, path, key, OpenMode::Initialize, options)
}

fn start<'env>(
    env: &'env Env,
    path: String,
    key: Buffer,
    mode: OpenMode,
    options: NativeOptions,
) -> napi::Result<PromiseRaw<'env, NativeConnection>> {
    let key = Zeroizing::new(
        <[u8; 32]>::try_from(key.as_ref())
            .map_err(|_| invalid("the execution storage key must contain 32 bytes"))?,
    );
    let capacity = NonZeroU32::new(options.queue_capacity)
        .ok_or_else(|| invalid("the storage queue capacity must be positive"))?;
    let cache_kib = options
        .cache_kib
        .map(|budget| {
            NonZeroU32::new(budget).ok_or_else(|| invalid("the pager budget must be positive"))
        })
        .transpose()?;
    let options = Options {
        cache_kib,
        busy_timeout: options
            .busy_timeout_ms
            .map(|millis| Duration::from_millis(u64::from(millis))),
    };
    let path = PathBuf::from(path);
    let (sender, receiver) = mpsc::channel(capacity.get() as usize);
    let (ready, opened) = oneshot::channel();
    std::thread::Builder::new()
        .name("execution-storage".into())
        .spawn(move || {
            let database = match mode {
                OpenMode::Create => Database::create(&path, &key, &options),
                OpenMode::Initialize => Database::initialize(&path, &key, &options),
                OpenMode::Existing => Database::open(&path, &key, &options),
            };
            drop(key);
            match database {
                Ok(database) => {
                    if ready.send(Ok(())).is_ok() {
                        serve(database, receiver);
                    }
                }
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|_| failed("the execution storage thread could not start"))?;
    env.spawn_future(async move {
        opened
            .await
            .map_err(|_| failed("the execution storage thread stopped while opening"))?
            .map_err(failed)?;
        Ok(NativeConnection { sender })
    })
}

fn serve(mut database: Database, mut receiver: mpsc::Receiver<Request>) {
    while let Some(request) = receiver.blocking_recv() {
        let mut closing = None;
        match request.operation {
            Operation::Begin => match database.begin() {
                Ok(mut transaction) => {
                    if request.result.send(Ok(Output::Empty)).is_err() {
                        return;
                    }
                    while let Some(request) = receiver.blocking_recv() {
                        match request.operation {
                            Operation::Commit => {
                                let _ = request.result.send(
                                    transaction
                                        .commit()
                                        .map(Output::Head)
                                        .map_err(|error| error.to_string()),
                                );
                                break;
                            }
                            Operation::Rollback => {
                                let _ = request.result.send(
                                    transaction
                                        .rollback()
                                        .map(|()| Output::Empty)
                                        .map_err(|error| error.to_string()),
                                );
                                break;
                            }
                            Operation::Close => {
                                if let Err(error) = transaction.rollback() {
                                    let _ = request.result.send(Err(error.to_string()));
                                    return;
                                }
                                closing = Some(request.result);
                                break;
                            }
                            operation => {
                                let result = in_transaction(&mut transaction, operation)
                                    .map_err(|error| error.to_string());
                                if request.result.send(result).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    let _ = request.result.send(Err(error.to_string()));
                }
            },
            Operation::Head => {
                let _ = request.result.send(
                    database
                        .head()
                        .map(Output::Head)
                        .map_err(|error| error.to_string()),
                );
            }
            Operation::Query(sql, values) => {
                let _ = request.result.send(
                    database
                        .query(&sql, &values)
                        .map(Output::Rows)
                        .map_err(|error| error.to_string()),
                );
            }
            Operation::Close => {
                let result = database
                    .close()
                    .map(|()| Output::Empty)
                    .map_err(|error| error.to_string());
                let _ = request.result.send(result);
                return;
            }
            _ => {
                let _ = request.result.send(Err(
                    "execution storage writes require an open transaction".into(),
                ));
            }
        }
        if let Some(result) = closing {
            let _ = result.send(
                database
                    .close()
                    .map(|()| Output::Empty)
                    .map_err(|error| error.to_string()),
            );
            return;
        }
    }
}

fn in_transaction(
    transaction: &mut Transaction<'_>,
    operation: Operation,
) -> chopin_storage::Result<Output> {
    match operation {
        Operation::Exec(sql) => transaction.exec(&sql).map(|()| Output::Empty),
        Operation::Run(sql, values) => transaction.run(&sql, &values).map(Output::Changed),
        Operation::Query(sql, values) => transaction.query(&sql, &values).map(Output::Rows),
        Operation::Prepare => transaction.prepare().map(Output::Prepared),
        _ => Err(chopin_storage::Error::RecoveryRequired),
    }
}

fn decode(values: Vec<SqlValue>) -> napi::Result<Vec<Value>> {
    values
        .into_iter()
        .map(|value| {
            Ok(match value {
                Either5::A(_) => Value::Null,
                Either5::B(number) if number.is_finite() => {
                    if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                        Value::Integer(number as i64)
                    } else {
                        Value::Real(number)
                    }
                }
                Either5::B(_) => return Err(invalid("SQL numbers must be finite")),
                Either5::C(number) => {
                    let (value, lossless) = number.get_i64();
                    if !lossless {
                        return Err(invalid("SQL integer exceeds its exact signed range"));
                    }
                    Value::Integer(value)
                }
                Either5::D(text) => Value::Text(text),
                Either5::E(bytes) => Value::Blob(bytes.to_vec()),
            })
        })
        .collect()
}

fn encode(output: Output) -> NativeResult {
    let mut result = NativeResult {
        head: None,
        previous: None,
        columns: Vec::new(),
        rows: Vec::new(),
        changes: None,
    };
    match output {
        Output::Empty => {}
        Output::Head(head) => result.head = Some(native_head(head)),
        Output::Prepared(prepared) => {
            result.head = Some(native_head(prepared.next));
            result.previous = Some(native_head(prepared.previous));
        }
        Output::Changed(changed) => result.changes = Some(changed.into()),
        Output::Rows(rows) => {
            result.columns = rows.columns;
            result.rows = rows
                .values
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|value| match value {
                            Value::Null => Either5::A(Null),
                            Value::Integer(value)
                                if value.unsigned_abs() <= 9_007_199_254_740_991 =>
                            {
                                Either5::B(value as f64)
                            }
                            Value::Integer(value) => Either5::C(value.into()),
                            Value::Real(value) => Either5::B(value),
                            Value::Text(value) => Either5::D(value),
                            Value::Blob(value) => Either5::E(value.into()),
                        })
                        .collect()
                })
                .collect();
        }
    }
    result
}

fn native_head(head: Head) -> NativeHead {
    NativeHead {
        sequence: head.sequence.into(),
        digest: head.digest.to_vec().into(),
    }
}

fn invalid(message: impl Into<String>) -> napi::Error {
    napi::Error::new(napi::Status::InvalidArg, message.into())
}
fn failed(message: impl Into<String>) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, message.into())
}
