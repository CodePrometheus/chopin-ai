//! Compatibility with the separate read-only vault verifier HTTP contract.

use serde::{Deserialize, Serialize};

use crate::{ProtocolError, wire::MAX_SAFE_INTEGER};

/// Fixed purpose of a read-only legacy vault verification.
pub const KEY_VERIFICATION_PURPOSE: &str = "chopin.vault.key-ownership";

/// Immutable reader identity bound independently by the host to an actual read-only pod.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyVerificationBindings {
    /// Supported representation version.
    pub version: u8,
    /// Fixed read-only verification purpose.
    pub purpose: String,
    /// Original verification operation UUID.
    pub operation_id: String,
    /// Expected logical agent UUID.
    pub agent_id: String,
    /// Expected platform owner UUID.
    pub owner_id: String,
    /// Exact read-only reader allocation UID.
    pub reader_pod_uid: String,
}

/// A dedicated one-attempt reader capability; it never contains a vault's service key or a control token.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyVerificationCapability {
    /// Supported representation version.
    pub version: u8,
    /// Fixed read-only verification purpose.
    pub purpose: String,
    /// Original verification operation UUID.
    pub operation_id: String,
    /// Expected logical agent UUID.
    pub agent_id: String,
    /// Expected platform owner UUID.
    pub owner_id: String,
    /// Exact read-only reader allocation UID.
    pub reader_pod_uid: String,
    /// Private one-attempt reader credential in canonical base64url.
    pub bearer_token: String,
    /// Absolute expiry in whole Unix seconds.
    pub expiry_unix_seconds: u64,
    /// Maximum encoded HTTP envelope in bytes.
    pub max_body_bytes: u64,
    /// Whole-request deadline in milliseconds.
    pub request_timeout_ms: u64,
}

/// Private HTTP body; the derived service key is serialized only into the protected request body.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyVerificationRequest {
    /// Supported representation version.
    pub version: u8,
    /// Fixed read-only verification purpose.
    pub purpose: String,
    /// Original verification operation UUID.
    pub operation_id: String,
    /// Expected logical agent UUID.
    pub agent_id: String,
    /// Expected platform owner UUID.
    pub owner_id: String,
    /// Exact read-only reader allocation UID.
    pub reader_pod_uid: String,
    /// Derived vault key in canonical base64url.
    pub service_key: String,
}

/// The reader returns its pinned identity alongside the existing-key receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyVerificationResponse {
    /// Supported representation version.
    pub version: u8,
    /// Fixed read-only verification purpose.
    pub purpose: String,
    /// Original verification operation UUID.
    pub operation_id: String,
    /// Expected logical agent UUID.
    pub agent_id: String,
    /// Expected platform owner UUID.
    pub owner_id: String,
    /// Exact read-only reader allocation UID.
    pub reader_pod_uid: String,
    /// Receipt for the existing key marker.
    pub verification: SealedKeyVerification,
}

macro_rules! binding {
    ($kind:ty) => {
        impl $kind {
            /// Identity echoed by the reader and checked against the admitted allocation.
            pub fn bindings(&self) -> KeyVerificationBindings {
                KeyVerificationBindings {
                    version: self.version,
                    purpose: self.purpose.clone(),
                    operation_id: self.operation_id.clone(),
                    agent_id: self.agent_id.clone(),
                    owner_id: self.owner_id.clone(),
                    reader_pod_uid: self.reader_pod_uid.clone(),
                }
            }
        }
    };
}
binding!(KeyVerificationCapability);
binding!(KeyVerificationRequest);
binding!(KeyVerificationResponse);

impl KeyVerificationBindings {
    /// Validates the purpose and canonical allocation identities.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != 1
            || self.purpose != KEY_VERIFICATION_PURPOSE
            || [
                &self.operation_id,
                &self.agent_id,
                &self.owner_id,
                &self.reader_pod_uid,
            ]
            .iter()
            .any(|value| uuid::Uuid::parse_str(value).map_or(true, |id| id.to_string() != **value))
        {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(())
    }
}

impl KeyVerificationCapability {
    /// Validates the binding, credential encoding and transport bounds.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.bindings().validate()?;
        if !(1..=MAX_SAFE_INTEGER).contains(&self.max_body_bytes)
            || !canonical_key(&self.bearer_token)
            || self.expiry_unix_seconds == 0
            || self.expiry_unix_seconds > MAX_SAFE_INTEGER / 1_000
            || self.request_timeout_ms == 0
            || self.request_timeout_ms > i32::MAX as u64
        {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(())
    }
}

impl KeyVerificationRequest {
    /// Validates the binding and the derived key encoding.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.bindings().validate()?;
        if !canonical_key(&self.service_key) {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(())
    }
}

impl KeyVerificationResponse {
    /// The expected binding must come from the host's independently verified allocation, never this response.
    pub fn validate_for(&self, expected: &KeyVerificationBindings) -> Result<(), ProtocolError> {
        expected.validate()?;
        if self.bindings() != *expected {
            return Err(ProtocolError::InvalidArguments);
        }
        self.verification.validate()
    }
}

impl std::fmt::Debug for KeyVerificationCapability {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("KeyVerificationCapability")
            .field("bindings", &self.bindings())
            .field("bearer_token", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for KeyVerificationRequest {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("KeyVerificationRequest")
            .field("bindings", &self.bindings())
            .field("service_key", &"[REDACTED]")
            .finish()
    }
}

fn canonical_key(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && value
            .as_bytes()
            .last()
            .is_some_and(|byte| b"AEIMQUYcgkosw048".contains(byte))
}

/// A trusted read-only verifier's key-ownership receipt; this does not prove volume ownership or data integrity.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealedKeyVerification {
    /// Supported representation version.
    pub version: u8,
    /// Whether the existing key-check record authenticated.
    pub verified: bool,
    /// SHA-256 of the exact existing key-check ciphertext which authenticated the supplied derived key.
    pub key_check_digest: String,
}

impl SealedKeyVerification {
    /// Call only after the host independently verified the read-only process and its exact bound volume.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != 1
            || !self.verified
            || self.key_check_digest.len() != 64
            || !self
                .key_check_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/key-verification-vectors.json"
        ))
        .unwrap()
    }

    #[test]
    fn reader_vectors_match_the_source_schema() {
        let vectors = vectors();
        for value in vectors["capability"]["valid"].as_array().unwrap() {
            serde_json::from_value::<KeyVerificationCapability>(value.clone())
                .unwrap()
                .validate()
                .unwrap();
        }
        for value in vectors["capability"]["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<KeyVerificationCapability>(value.clone())
                    .and_then(|value| value.validate().map_err(serde::de::Error::custom))
                    .is_err()
            );
        }
        for value in vectors["request"]["valid"].as_array().unwrap() {
            serde_json::from_value::<KeyVerificationRequest>(value.clone())
                .unwrap()
                .validate()
                .unwrap();
        }
        for value in vectors["request"]["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<KeyVerificationRequest>(value.clone())
                    .and_then(|value| value.validate().map_err(serde::de::Error::custom))
                    .is_err()
            );
        }
        let expected = serde_json::from_value::<KeyVerificationCapability>(
            vectors["capability"]["valid"][0].clone(),
        )
        .unwrap()
        .bindings();
        for value in vectors["response"]["valid"].as_array().unwrap() {
            serde_json::from_value::<KeyVerificationResponse>(value.clone())
                .unwrap()
                .validate_for(&expected)
                .unwrap();
        }
        for value in vectors["response"]["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<KeyVerificationResponse>(value.clone())
                    .and_then(|value| value
                        .validate_for(&expected)
                        .map_err(serde::de::Error::custom))
                    .is_err()
            );
        }
    }

    #[test]
    fn reader_receipt_cannot_change_the_hosts_allocation() {
        let vectors = vectors();
        let capability = serde_json::from_value::<KeyVerificationCapability>(
            vectors["capability"]["valid"][0].clone(),
        )
        .unwrap();
        let response = serde_json::from_value::<KeyVerificationResponse>(
            vectors["response"]["valid"][0].clone(),
        )
        .unwrap();
        let mut expected = capability.bindings();
        expected.reader_pod_uid = uuid::Uuid::new_v4().to_string();
        assert!(response.validate_for(&expected).is_err());
        expected = capability.bindings();
        expected.operation_id = uuid::Uuid::new_v4().to_string();
        assert!(response.validate_for(&expected).is_err());
    }

    #[test]
    fn secret_request_and_capability_debug_output_is_redacted() {
        let vectors = vectors();
        let capability = serde_json::from_value::<KeyVerificationCapability>(
            vectors["capability"]["valid"][0].clone(),
        )
        .unwrap();
        let request = serde_json::from_value::<KeyVerificationRequest>(
            vectors["request"]["valid"][0].clone(),
        )
        .unwrap();
        assert!(!format!("{capability:?}").contains(&capability.bearer_token));
        assert!(!format!("{request:?}").contains(&request.service_key));
    }
}
