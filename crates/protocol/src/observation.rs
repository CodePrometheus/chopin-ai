use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::{
    ChordClient, ProtocolError, Result,
    client::{Contract, Variant, remote_error},
    delta::Decoder,
    wire::{Binding, Change, Frame},
};

/// One applied change; the revision counts deliveries only within this observation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateUpdate {
    /// Connection-local monotonic delivery count, not a durable resume cursor.
    pub revision: u64,
    /// Changed JSON paths grouped by state member; an empty path replaces that member.
    pub changed_paths: BTreeMap<String, Vec<Vec<Value>>>,
    /// Members removed by a new binding or whose source document retired.
    /// A retired source does not itself remove the member's last value.
    pub retired_members: Vec<String>,
}

/// A dedicated connection holding one authoritative replicated object.
///
/// Interrupted or invalid updates invalidate the observation. Start a new one
/// to obtain a fresh snapshot, without sending any execution stop command.
pub struct StateObserver {
    client: ChordClient,
    state: ObservationState,
    readable: bool,
    revision: u64,
}

impl std::fmt::Debug for StateObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateObserver")
            .field("readable", &self.readable)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

impl StateObserver {
    pub(crate) fn new(client: ChordClient, state: ObservationState) -> Self {
        Self {
            client,
            state,
            readable: true,
            revision: 0,
        }
    }

    /// Borrows the last complete state without cloning unchanged history.
    pub fn state(&self) -> Result<&Value> {
        if !self.readable {
            return Err(ProtocolError::Interrupted);
        }
        Ok(&self.state.value)
    }

    /// Waits for one complete state change. Dropping this future invalidates the observation.
    pub async fn next(&mut self) -> Result<StateUpdate> {
        self.client.begin()?;
        self.readable = false;
        let mut update = StateUpdate::default();
        loop {
            if self
                .state
                .apply(self.client.receive().await?, &mut update)?
            {
                self.client.acknowledge().await?;
            }
            if !update.changed_paths.is_empty() || !update.retired_members.is_empty() {
                self.revision = self
                    .revision
                    .checked_add(1)
                    .ok_or(ProtocolError::InvalidState)?;
                update.revision = self.revision;
                self.readable = true;
                self.client.finish();
                return Ok(update);
            }
        }
    }

    /// Releases the reference and connection; remote execution keeps its own lifecycle.
    pub async fn close(mut self) -> Result<()> {
        self.readable = false;
        self.client.release(self.state.id).await?;
        self.client.close().await
    }
}

pub(crate) struct ObservationState {
    id: u64,
    contract: Contract,
    variant: usize,
    decoders: BTreeMap<String, Decoder>,
    value: Value,
}

impl ObservationState {
    pub(crate) fn new(contract: Contract, binding: Binding) -> Result<Self> {
        let mut state = Self {
            id: binding.hold,
            contract,
            variant: 0,
            decoders: BTreeMap::new(),
            value: Value::Object(Map::new()),
        };
        state.bind(binding, &mut StateUpdate::default())?;
        Ok(state)
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }
    pub(crate) fn into_value(self) -> Value {
        self.value
    }

    pub(crate) fn method(&self, name: &str) -> Option<u64> {
        self.contract
            .variants
            .get(self.variant)?
            .methods
            .iter()
            .position(|method| method == name)
            .and_then(|index| u64::try_from(index).ok())
    }

    fn variant(&self) -> Result<&Variant> {
        self.contract
            .variants
            .get(self.variant)
            .ok_or(ProtocolError::InvalidFrame)
    }

    fn name(&self, index: u64) -> Result<&str> {
        let index = usize::try_from(index).map_err(|_| ProtocolError::InvalidFrame)?;
        self.variant()?
            .state
            .get(index)
            .map(String::as_str)
            .ok_or(ProtocolError::InvalidFrame)
    }

    fn bind(&mut self, binding: Binding, update: &mut StateUpdate) -> Result<()> {
        let index = usize::try_from(binding.variant).map_err(|_| ProtocolError::InvalidFrame)?;
        let variant = self
            .contract
            .variants
            .get(index)
            .ok_or(ProtocolError::InvalidFrame)?;
        if !binding.failed.is_empty() {
            return Err(ProtocolError::InvalidState);
        }
        let mut object = Map::new();
        for member in binding.members {
            let name = variant
                .state
                .get(usize::try_from(member.member).map_err(|_| ProtocolError::InvalidFrame)?)
                .ok_or(ProtocolError::InvalidFrame)?;
            if object.insert(name.clone(), member.value).is_some() {
                return Err(ProtocolError::InvalidFrame);
            }
            update.changed_paths.insert(name.clone(), vec![Vec::new()]);
        }
        if object.len() != variant.state.len() {
            return Err(ProtocolError::InvalidFrame);
        }
        if let Some(previous) = self.value.as_object() {
            update.retired_members.extend(
                previous
                    .keys()
                    .filter(|name| !object.contains_key(*name))
                    .cloned(),
            );
        }
        self.value = Value::Object(object);
        self.decoders.clear();
        self.variant = index;
        Ok(())
    }

    fn change(&mut self, change: Change, update: &mut StateUpdate) -> Result<()> {
        if !change.failed.is_empty() {
            return Err(ProtocolError::InvalidState);
        }
        let mut seen = BTreeSet::new();
        for member in change.members {
            if !seen.insert(member.member) {
                return Err(ProtocolError::InvalidFrame);
            }
            let name = self.name(member.member)?.to_owned();
            let object = self
                .value
                .as_object_mut()
                .ok_or(ProtocolError::InvalidState)?;
            let (value, paths) = self
                .decoders
                .entry(name.clone())
                .or_default()
                .apply(object.remove(&name), member.ops)?;
            object.insert(name.clone(), value.ok_or(ProtocolError::InvalidState)?);
            if !paths.is_empty() {
                update.changed_paths.entry(name).or_default().extend(paths);
            }
        }
        let mut retired = BTreeSet::new();
        for index in change.retired {
            if !retired.insert(index) {
                return Err(ProtocolError::InvalidFrame);
            }
            update.retired_members.push(self.name(index)?.to_owned());
        }
        Ok(())
    }

    pub(crate) fn apply(&mut self, frame: Frame, update: &mut StateUpdate) -> Result<bool> {
        match frame {
            Frame::Bound { holds } => {
                let mut seen = BTreeSet::new();
                for binding in holds {
                    if binding.hold > self.id || !seen.insert(binding.hold) {
                        return Err(ProtocolError::InvalidFrame);
                    }
                    if binding.hold == self.id {
                        self.bind(binding, update)?;
                    }
                }
                Ok(true)
            }
            Frame::State { holds } => {
                let mut seen = BTreeSet::new();
                for change in holds {
                    if change.hold > self.id || !seen.insert(change.hold) {
                        return Err(ProtocolError::InvalidFrame);
                    }
                    if change.hold == self.id {
                        self.change(change, update)?;
                    }
                }
                Ok(true)
            }
            Frame::Gone { hold, error }
            | Frame::Failed {
                hold,
                cause: crate::wire::Cause { error, .. },
                ..
            } if hold == self.id => Err(remote_error("observe", error)),
            Frame::Loading { hold } if hold == self.id => Err(ProtocolError::InvalidState),
            Frame::Gone { hold, .. } | Frame::Failed { hold, .. } | Frame::Loading { hold }
                if hold < self.id =>
            {
                Ok(false)
            }
            _ => Err(ProtocolError::InvalidFrame),
        }
    }
}
