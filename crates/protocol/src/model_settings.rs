//! Credential metadata and model availability returned by one owner snapshot.

use serde::{Deserialize, Serialize};

use crate::{ModelChoice, ModelReference};

/// Kind of a stored model credential. Values exclude credential material.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCredentialKind {
    /// An API key issued by the provider.
    ApiKey,
    /// A provider-issued login grant.
    Oauth,
}

/// A credential the owner has stored for one provider.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCredentialInfo {
    /// Identity of the provider.
    pub provider: String,
    /// Credential kind.
    #[serde(rename = "type")]
    pub kind: ModelCredentialKind,
}

/// An available way to register a provider credential.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelLoginWay {
    /// Credential kind accepted by the method.
    #[serde(rename = "type")]
    pub kind: ModelCredentialKind,
    /// Source display label.
    pub name: String,
    /// Whether the provider designates this method as a subscription login.
    pub subscription: bool,
}

/// An owner-configurable provider in the trusted model catalog.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSettingsProvider {
    /// Identity of the provider.
    pub id: String,
    /// Source display name.
    pub name: String,
    /// Authentication methods this service currently supports.
    pub ways: Vec<ModelLoginWay>,
    /// Hosts used by the admitted models.
    pub hosts: Vec<String>,
}

/// The owner's complete model settings as read from the execution service.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelSettingsSnapshot {
    /// Providers that the owner can configure.
    pub providers: Vec<ModelSettingsProvider>,
    /// Stored credential metadata.
    pub credentials: Vec<ModelCredentialInfo>,
    /// Models usable with the current personal authorization.
    pub models: Vec<ModelChoice>,
    /// Available execution model.
    pub execution: Option<ModelReference>,
    /// Available review model.
    pub review: Option<ModelReference>,
}
