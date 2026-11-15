use flate2::{Decompress, FlushDecompress, Status};
use serde::Serialize;
use serde_json::Value;

use crate::{ProtocolError, Result};

pub(crate) const PROTOCOL_VERSION: u64 = 1;
pub(crate) const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
// The producer's untrusted-link defaults, per part.
pub(crate) const MAX_PART: usize = 16 * 1024 * 1024;
pub(crate) const MAX_DECODED: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Frame {
    Hello {
        protocol: u64,
        incarnation: String,
        calls: u64,
    },
    Bound {
        holds: Vec<Binding>,
    },
    State {
        holds: Vec<Change>,
    },
    Failed {
        hold: u64,
        cause: Cause,
        #[serde(rename = "retryIn", skip_serializing_if = "Option::is_none")]
        retry_in: Option<u64>,
    },
    Result {
        call: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
    Error {
        call: u64,
        error: Value,
    },
    Gone {
        hold: u64,
        error: Value,
    },
    Loading {
        hold: u64,
    },
    Ack,
    Ping,
    Pong,
}

#[derive(Debug, Serialize)]
pub(crate) struct Binding {
    pub hold: u64,
    pub variant: u64,
    pub members: Vec<Member>,
    pub failed: Vec<Failure>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Member {
    pub member: u64,
    pub value: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct Failure {
    pub member: u64,
    pub error: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct Change {
    pub hold: u64,
    pub members: Vec<Operations>,
    pub failed: Vec<Failure>,
    pub retired: Vec<u64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Operations {
    pub member: u64,
    pub ops: Vec<Vec<Value>>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Cause {
    pub kind: &'static str,
    pub error: Value,
}

pub(crate) enum Outgoing<'a> {
    Hello {
        incarnation: uuid::Uuid,
    },
    Hold {
        hold: u64,
        name: &'a str,
        version: u64,
        fingerprint: &'a str,
        params: &'a Value,
        address: &'a Value,
    },
    Release {
        hold: u64,
    },
    Call {
        call: u64,
        hold: u64,
        method: u64,
        args: Option<&'a Value>,
    },
    Ack,
    Pong,
}

pub(crate) fn encode(frame: Outgoing<'_>) -> Result<Vec<u8>> {
    let mut writer = Writer(Vec::new());
    match frame {
        Outgoing::Hello { incarnation } => {
            writer.0.push(0);
            writer.number(PROTOCOL_VERSION)?;
            writer.0.extend_from_slice(incarnation.as_bytes());
            // This sequential consumer accepts no incoming application calls.
            writer.number(1)?;
        }
        Outgoing::Hold {
            hold,
            name,
            version,
            fingerprint,
            params,
            address,
        } => {
            writer.0.push(1);
            writer.number(hold)?;
            writer.string(name)?;
            writer.number(version)?;
            if fingerprint.len() != 16
                || !fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ProtocolError::InvalidFrame);
            }
            for index in (0..16).step_by(2) {
                writer.0.push(
                    u8::from_str_radix(&fingerprint[index..index + 2], 16)
                        .map_err(|_| ProtocolError::InvalidFrame)?,
                );
            }
            writer.part(params)?;
            writer.string(
                address["kind"]
                    .as_str()
                    .ok_or(ProtocolError::InvalidFrame)?,
            )?;
            writer.json(address.get("params").ok_or(ProtocolError::InvalidFrame)?)?;
            writer.0.push(0);
        }
        Outgoing::Release { hold } => {
            writer.0.push(2);
            writer.number(hold)?;
        }
        Outgoing::Call {
            call,
            hold,
            method,
            args,
        } => {
            writer.0.push(3);
            writer.number(call)?;
            writer.number(hold)?;
            writer.number(method)?;
            writer.number(u64::from(args.is_some()))?;
            if let Some(args) = args {
                writer.part(args)?;
            }
        }
        Outgoing::Ack => writer.0.push(13),
        Outgoing::Pong => writer.0.push(16),
    }
    Ok(writer.0)
}

pub(crate) fn binary(data: &[u8], maximum: Option<usize>, decoded: Option<usize>) -> Result<Frame> {
    let mut reader = Reader {
        data,
        maximum,
        decoded,
    };
    // Relayed origins, provider-side messages and trace carriers do not belong to this consumer.
    let frame = match reader.byte()? {
        0 => {
            let protocol = reader.number()?;
            let incarnation = uuid::Uuid::from_slice(reader.take(16)?)
                .map_err(|_| ProtocolError::InvalidFrame)?
                .to_string();
            let calls = reader.number()?;
            if calls == 0 {
                return Err(ProtocolError::InvalidFrame);
            }
            Frame::Hello {
                protocol,
                incarnation,
                calls,
            }
        }
        5 => Frame::Bound {
            holds: reader.list(|reader| {
                Ok(Binding {
                    hold: reader.number()?,
                    variant: reader.number()?,
                    members: reader.list(|reader| {
                        Ok(Member {
                            member: reader.number()?,
                            value: reader.part()?,
                        })
                    })?,
                    failed: {
                        let count = reader.count()?;
                        reader.failures(count)?
                    },
                })
            })?,
        },
        6 => Frame::State {
            holds: reader.list(|reader| {
                let hold = reader.number()?;
                let members = reader.list(|reader| {
                    Ok(Operations {
                        member: reader.number()?,
                        ops: serde_json::from_value(reader.part()?)?,
                    })
                })?;
                let flags = reader.number()?;
                let failed = reader.failures(
                    usize::try_from(flags / 2).map_err(|_| ProtocolError::InvalidFrame)?,
                )?;
                let retired = if flags % 2 == 0 {
                    Vec::new()
                } else {
                    reader.list(|reader| reader.number())?
                };
                Ok(Change {
                    hold,
                    members,
                    failed,
                    retired,
                })
            })?,
        },
        7 => {
            let hold = reader.number()?;
            let kind = match reader.byte()? {
                0 => "transient",
                1 => "broken",
                2 => "waiting",
                _ => return Err(ProtocolError::InvalidFrame),
            };
            let error = reader.error()?;
            let retry_in = reader.number()?.checked_sub(1);
            Frame::Failed {
                hold,
                cause: Cause { kind, error },
                retry_in,
            }
        }
        8 => Frame::Result {
            call: reader.number()?,
            value: reader.payload()?,
        },
        9 => Frame::Error {
            call: reader.number()?,
            error: reader.error()?,
        },
        10 => Frame::Gone {
            hold: reader.number()?,
            error: reader.error()?,
        },
        12 => Frame::Loading {
            hold: reader.number()?,
        },
        13 => Frame::Ack,
        15 => Frame::Ping,
        16 => Frame::Pong,
        _ => return Err(ProtocolError::InvalidFrame),
    };
    if !reader.data.is_empty() {
        return Err(ProtocolError::InvalidFrame);
    }
    Ok(frame)
}

struct Reader<'a> {
    data: &'a [u8],
    maximum: Option<usize>,
    decoded: Option<usize>,
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let (part, rest) = self
            .data
            .split_at_checked(length)
            .ok_or(ProtocolError::InvalidFrame)?;
        self.data = rest;
        Ok(part)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn number(&mut self) -> Result<u64> {
        let mut value = 0;
        for shift in (0..56).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if value > MAX_SAFE_INTEGER {
                return Err(ProtocolError::InvalidFrame);
            }
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(ProtocolError::InvalidFrame)
    }

    fn length(&mut self) -> Result<usize> {
        usize::try_from(self.number()?).map_err(|_| ProtocolError::InvalidFrame)
    }

    fn count(&mut self) -> Result<usize> {
        let count = self.length()?;
        if count > self.data.len() {
            return Err(ProtocolError::InvalidFrame);
        }
        Ok(count)
    }

    fn list<T>(&mut self, mut read: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let count = self.count()?;
        (0..count).map(|_| read(self)).collect()
    }

    fn json(&mut self) -> Result<Value> {
        let size = self.length()?;
        Ok(serde_json::from_slice(self.take(size)?)?)
    }

    fn error(&mut self) -> Result<Value> {
        let value = self.json()?;
        let valid = match value["kind"].as_str() {
            Some("plugin") => {
                value["code"].is_string()
                    && value["message"].is_string()
                    && only(&value, &["kind", "code", "message", "details"])
            }
            Some("chord") => only(&value, &["kind", "error"]) && chord_error(&value["error"]),
            _ => false,
        };
        if !valid {
            return Err(ProtocolError::InvalidFrame);
        }
        Ok(value)
    }

    fn failures(&mut self, count: usize) -> Result<Vec<Failure>> {
        if count > self.data.len() {
            return Err(ProtocolError::InvalidFrame);
        }
        (0..count)
            .map(|_| {
                Ok(Failure {
                    member: self.number()?,
                    error: self.error()?,
                })
            })
            .collect()
    }

    fn part(&mut self) -> Result<Value> {
        let prefix = self.number()?;
        let size = usize::try_from(prefix / 2).map_err(|_| ProtocolError::InvalidFrame)?;
        if self.maximum.is_some_and(|maximum| size > maximum) {
            return Err(ProtocolError::MessageTooLarge);
        }
        let bytes = self.take(size)?;
        if prefix % 2 == 0 {
            if self.decoded.is_some_and(|maximum| size > maximum) {
                return Err(ProtocolError::MessageTooLarge);
            }
            Ok(serde_json::from_slice(bytes)?)
        } else {
            Ok(serde_json::from_slice(&inflate(bytes, self.decoded)?)?)
        }
    }

    fn payload(&mut self) -> Result<Option<Value>> {
        match self.number()? {
            0 => Ok(None),
            1 => self.part().map(Some),
            // Application contracts currently have no byte-segment schemas.
            _ => Err(ProtocolError::InvalidFrame),
        }
    }
}

fn only(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}

fn chord_error(value: &Value) -> bool {
    let reasons: &[&str] = match value["code"].as_str() {
        Some("invalid") => &[
            "args",
            "params",
            "member",
            "host_address",
            "reentrant",
            "read_after_bulk",
            "cycle",
        ],
        Some("contract_mismatch") => &["updating"],
        Some("forbidden") => &["revoked"],
        Some("gone" | "not_ready" | "aborted") => &[],
        Some("released") => &["ended", "closed", "settled", "version", "discarded"],
        Some("too_large") => &["part"],
        Some("unavailable") => &[
            "locked",
            "park_timeout",
            "busy",
            "storage_failed",
            "undeclared",
            "version",
            "reload_cycle",
        ],
        _ => return false,
    };
    value["message"].is_string()
        && only(value, &["code", "reason", "message", "details"])
        && match value.get("reason") {
            Some(reason) => reason
                .as_str()
                .is_some_and(|reason| reasons.contains(&reason)),
            None => value["code"] != "invalid",
        }
}

fn inflate(data: &[u8], maximum: Option<usize>) -> Result<Vec<u8>> {
    let mut decoder = Decompress::new(false);
    let mut output = Vec::new();
    let mut remaining = data;
    loop {
        let mut buffer = [0; 8192];
        let before_in = decoder.total_in();
        let before_out = decoder.total_out();
        let status = decoder
            .decompress(remaining, &mut buffer, FlushDecompress::None)
            .map_err(|_| ProtocolError::InvalidFrame)?;
        let read = usize::try_from(decoder.total_in() - before_in)
            .map_err(|_| ProtocolError::InvalidFrame)?;
        let written = usize::try_from(decoder.total_out() - before_out)
            .map_err(|_| ProtocolError::InvalidFrame)?;
        if maximum.is_some_and(|maximum| output.len().saturating_add(written) > maximum) {
            return Err(ProtocolError::MessageTooLarge);
        }
        output.extend_from_slice(&buffer[..written]);
        remaining = &remaining[read..];
        if status == Status::StreamEnd {
            return if remaining.is_empty() {
                Ok(output)
            } else {
                Err(ProtocolError::InvalidFrame)
            };
        }
        if read == 0 && written == 0 {
            return Err(ProtocolError::InvalidFrame);
        }
    }
}

struct Writer(Vec<u8>);

impl Writer {
    fn number(&mut self, mut value: u64) -> Result<()> {
        if value > MAX_SAFE_INTEGER {
            return Err(ProtocolError::InvalidFrame);
        }
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            self.0.push(byte | if value == 0 { 0 } else { 0x80 });
            if value == 0 {
                return Ok(());
            }
        }
    }

    fn string(&mut self, value: &str) -> Result<()> {
        self.number(u64::try_from(value.len()).map_err(|_| ProtocolError::MessageTooLarge)?)?;
        self.0.extend_from_slice(value.as_bytes());
        Ok(())
    }

    fn json(&mut self, value: &Value) -> Result<()> {
        self.string(&serde_json::to_string(value)?)
    }

    fn part(&mut self, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        self.number(
            u64::try_from(bytes.len())
                .ok()
                .and_then(|length| length.checked_mul(2))
                .ok_or(ProtocolError::MessageTooLarge)?,
        )?;
        self.0.extend_from_slice(&bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Packed {
        message: Vec<u8>,
        unfinished: Vec<u8>,
        expected: Value,
    }
    #[derive(Deserialize)]
    struct Fixture {
        bytes: Vec<u8>,
        expected: Value,
    }

    fn packed() -> Packed {
        serde_json::from_str(include_str!("../tests/fixtures/packed.json")).unwrap()
    }

    #[test]
    fn producer_frames() {
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("../tests/fixtures/wire.json")).unwrap();
        for fixture in fixtures {
            let frame = binary(&fixture.bytes, Some(MAX_PART), Some(MAX_DECODED)).unwrap();
            assert_eq!(serde_json::to_value(frame).unwrap(), fixture.expected);
        }
    }

    #[test]
    fn producer_packet() {
        let fixture = packed();
        let Frame::Result { call, value } = binary(&fixture.message, None, None).unwrap() else {
            panic!("expected a result");
        };
        assert_eq!(call, 1);
        assert_eq!(value, Some(fixture.expected));
    }

    #[test]
    fn decoded_bounds() {
        let fixture = packed();
        let length = serde_json::to_vec(&fixture.expected).unwrap().len();
        assert!(matches!(
            binary(&fixture.message, None, Some(length - 1)),
            Err(ProtocolError::MessageTooLarge)
        ));
        assert!(binary(&fixture.message, None, Some(length)).is_ok());
        assert!(binary(&fixture.message, None, Some(usize::MAX)).is_ok());
        assert!(matches!(
            binary(&fixture.message, Some(0), None),
            Err(ProtocolError::MessageTooLarge)
        ));
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("../tests/fixtures/wire.json")).unwrap();
        let plain = fixtures
            .iter()
            .find(|fixture| fixture.expected["call"] == 2)
            .unwrap();
        assert!(matches!(
            binary(&plain.bytes, None, Some(0)),
            Err(ProtocolError::MessageTooLarge)
        ));
    }

    #[test]
    fn truncated_packet() {
        let mut fixture = packed();
        for end in 0..fixture.message.len() {
            assert!(
                binary(&fixture.message[..end], None, None).is_err(),
                "truncation at {end}"
            );
        }
        fixture.message.push(0);
        assert!(binary(&fixture.message, None, None).is_err());
    }

    #[test]
    fn unfinished_stream() {
        assert!(binary(&packed().unfinished, None, None).is_err());
    }

    #[test]
    fn invalid_envelope() {
        let frames: Vec<Vec<u8>> =
            serde_json::from_str(include_str!("../tests/fixtures/invalid-frames.json")).unwrap();
        for frame in frames {
            assert!(binary(&frame, None, None).is_err());
        }
        // Oversized counts, overflowing varints, relay origins and byte segments are refused.
        for frame in [
            vec![5, 127],
            vec![8, 255, 255, 255, 255, 255, 255, 255, 127],
            vec![0x80, 1],
            vec![8, 1, 3, 8, b'n', b'u', b'l', b'l', 0],
        ] {
            assert!(binary(&frame, None, None).is_err());
        }
    }
}
