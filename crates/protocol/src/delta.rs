use std::{collections::BTreeMap, sync::Arc};

use serde_json::Value;

use crate::{ProtocolError, Result};

/// Dictionaries belong to one state member, not to its containing connection.
#[derive(Debug, Default)]
pub(crate) struct Decoder {
    paths: BTreeMap<u64, Arc<[Value]>>,
}

impl Decoder {
    pub(crate) fn reset(&mut self) {
        self.paths.clear();
    }

    /// Ownership prevents a failed batch from exposing a partially changed value.
    pub(crate) fn apply(
        &mut self,
        mut root: Option<Value>,
        batch: Vec<Vec<Value>>,
    ) -> Result<(Option<Value>, Vec<Vec<Value>>)> {
        let mut previous: Option<Arc<[Value]>> = None;
        let mut changed = Vec::new();
        for mut op in batch {
            let verb = op
                .first()
                .and_then(Value::as_str)
                .ok_or(ProtocolError::InvalidState)?
                .to_owned();
            if verb == "r" {
                if op.len() != 2 {
                    return Err(ProtocolError::InvalidState);
                }
                root = op.pop();
                self.reset();
                previous = None;
                changed.push(Vec::new());
                continue;
            }
            if verb == "#" {
                if op.len() != 3 {
                    return Err(ProtocolError::InvalidState);
                }
                let id = op[1].as_u64().ok_or(ProtocolError::InvalidState)?;
                let path = path(op.pop().ok_or(ProtocolError::InvalidState)?)?;
                self.paths.insert(id, path);
                continue;
            }
            let arity = match verb.as_str() {
                "s" | "a" | "t" | "m" => 3,
                "d" => 2,
                "p" => 5,
                _ => return Err(ProtocolError::InvalidState),
            };
            let short = op.len() == arity - 1;
            if !short && op.len() != arity {
                return Err(ProtocolError::InvalidState);
            }
            let mut values = op.into_iter().skip(1);
            let selected = if short {
                previous.clone().ok_or(ProtocolError::InvalidState)?
            } else {
                let reference = values.next().ok_or(ProtocolError::InvalidState)?;
                let selected = if let Some(id) = reference.as_u64() {
                    self.paths
                        .get(&id)
                        .cloned()
                        .ok_or(ProtocolError::InvalidState)?
                } else {
                    path(reference)?
                };
                previous = Some(selected.clone());
                selected
            };
            if selected.is_empty() && !matches!(verb.as_str(), "p" | "m") {
                return Err(ProtocolError::InvalidState);
            }
            let root = root.as_mut().ok_or(ProtocolError::InvalidState)?;
            match verb.as_str() {
                "s" => set(
                    root,
                    &selected,
                    values.next().ok_or(ProtocolError::InvalidState)?,
                )?,
                "d" => remove(root, &selected)?,
                "a" => {
                    let text = values.next().ok_or(ProtocolError::InvalidState)?;
                    let text = text.as_str().ok_or(ProtocolError::InvalidState)?;
                    let Value::String(current) = resolve(root, &selected)? else {
                        return Err(ProtocolError::InvalidState);
                    };
                    current.push_str(text);
                }
                "t" => {
                    let count = index(&values.next().ok_or(ProtocolError::InvalidState)?)?;
                    let Value::String(current) = resolve(root, &selected)? else {
                        return Err(ProtocolError::InvalidState);
                    };
                    let units: Vec<u16> = current.encode_utf16().skip(count).collect();
                    *current =
                        String::from_utf16(&units).map_err(|_| ProtocolError::InvalidState)?;
                }
                "p" => {
                    let start = index(&values.next().ok_or(ProtocolError::InvalidState)?)?;
                    let remove = index(&values.next().ok_or(ProtocolError::InvalidState)?)?;
                    let Value::Array(items) = values.next().ok_or(ProtocolError::InvalidState)?
                    else {
                        return Err(ProtocolError::InvalidState);
                    };
                    let Value::Array(target) = resolve(root, &selected)? else {
                        return Err(ProtocolError::InvalidState);
                    };
                    let start = start.min(target.len());
                    let end = start + remove.min(target.len() - start);
                    target.splice(start..end, items);
                }
                "m" => {
                    let Value::Array(permutation) =
                        values.next().ok_or(ProtocolError::InvalidState)?
                    else {
                        return Err(ProtocolError::InvalidState);
                    };
                    let Value::Array(target) = resolve(root, &selected)? else {
                        return Err(ProtocolError::InvalidState);
                    };
                    if permutation.len() != target.len() {
                        return Err(ProtocolError::InvalidState);
                    }
                    let mut original: Vec<Option<Value>> =
                        std::mem::take(target).into_iter().map(Some).collect();
                    for position in permutation {
                        let item = original
                            .get_mut(index(&position)?)
                            .and_then(Option::take)
                            .ok_or(ProtocolError::InvalidState)?;
                        target.push(item);
                    }
                }
                _ => return Err(ProtocolError::InvalidState),
            }
            changed.push(selected.to_vec());
        }
        Ok((root, changed))
    }
}

fn path(value: Value) -> Result<Arc<[Value]>> {
    let Value::Array(segments) = value else {
        return Err(ProtocolError::InvalidState);
    };
    for segment in &segments {
        match segment {
            Value::String(key)
                if !matches!(key.as_str(), "__proto__" | "constructor" | "prototype") => {}
            Value::Number(_) if segment.as_u64().is_some() => {}
            _ => return Err(ProtocolError::InvalidState),
        }
    }
    Ok(segments.into())
}

fn index(value: &Value) -> Result<usize> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(ProtocolError::InvalidState)
}

fn key(value: &Value) -> Result<std::borrow::Cow<'_, str>> {
    match value {
        Value::String(key) => Ok(key.into()),
        Value::Number(_) => Ok(value
            .as_u64()
            .ok_or(ProtocolError::InvalidState)?
            .to_string()
            .into()),
        _ => Err(ProtocolError::InvalidState),
    }
}

fn resolve<'a>(mut target: &'a mut Value, path: &[Value]) -> Result<&'a mut Value> {
    for segment in path {
        target = match target {
            Value::Object(object) => object.get_mut(key(segment)?.as_ref()),
            Value::Array(array) => array.get_mut(index(segment)?),
            _ => None,
        }
        .ok_or(ProtocolError::InvalidState)?;
    }
    Ok(target)
}

fn set(target: &mut Value, path: &[Value], value: Value) -> Result<()> {
    let (last, parents) = path.split_last().ok_or(ProtocolError::InvalidState)?;
    match resolve(target, parents)? {
        Value::Object(object) => {
            object.insert(key(last)?.into_owned(), value);
        }
        Value::Array(array) => {
            let position = index(last)?;
            if position == array.len() {
                array.push(value);
            } else {
                *array.get_mut(position).ok_or(ProtocolError::InvalidState)? = value;
            }
        }
        _ => return Err(ProtocolError::InvalidState),
    }
    Ok(())
}

fn remove(target: &mut Value, path: &[Value]) -> Result<()> {
    let (last, parents) = path.split_last().ok_or(ProtocolError::InvalidState)?;
    match resolve(target, parents)? {
        Value::Object(object) => {
            object.remove(key(last)?.as_ref());
        }
        Value::Array(array) => {
            let position = index(last)?;
            if position >= array.len() {
                return Err(ProtocolError::InvalidState);
            }
            array.remove(position);
        }
        _ => return Err(ProtocolError::InvalidState),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixtures {
        base: Value,
        batches: Vec<Batch>,
        malformed: Vec<Vec<Vec<Value>>>,
    }
    #[derive(Deserialize)]
    struct Batch {
        wire: Vec<Vec<Value>>,
        expected: Value,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(include_str!("../tests/fixtures/deltas.json")).unwrap()
    }

    #[test]
    fn producer_batches() {
        let fixtures = fixtures();
        let mut decoder = Decoder::default();
        let mut value = Some(fixtures.base);
        for batch in fixtures.batches {
            let (next, paths) = decoder.apply(value, batch.wire).unwrap();
            assert_eq!(next, Some(batch.expected));
            assert!(!paths.is_empty());
            value = next;
        }
    }

    #[test]
    fn invalid_operations() {
        let fixtures = fixtures();
        for wire in fixtures.malformed {
            let result = Decoder::default().apply(Some(fixtures.base.clone()), wire);
            assert!(result.is_err());
        }
    }

    #[test]
    fn invalid_utf16() {
        let base = serde_json::json!({ "text": "\u{20000}x" });
        let wire = serde_json::from_value(serde_json::json!([["t", ["text"], 1]])).unwrap();
        assert!(matches!(
            Decoder::default().apply(Some(base), wire),
            Err(ProtocolError::InvalidState)
        ));
    }
}
