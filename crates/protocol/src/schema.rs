//! Optional host schemas over the producer's canonical command representation.

use std::{borrow::Cow, sync::LazyLock};

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde_json::Value;

use crate::{EngineCommand, GoalCommand};

#[expect(
    clippy::expect_used,
    reason = "the producer fixture gate validates the bundled schemas and their locations"
)]
fn command_schema(pointer: &str) -> Schema {
    static CONTRACTS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../contracts.json"))
            .expect("bundled producer contracts must contain valid JSON")
    });
    let variant = CONTRACTS["contracts"]["chopin.goals"]["variants"]
        .as_array()
        .and_then(|variants| variants.iter().find(|variant| variant["name"] == "owner"))
        .expect("bundled producer contracts must declare owner goal commands");
    variant
        .pointer(pointer)
        .expect("bundled producer contracts must contain the command schema")
        .clone()
        .try_into()
        .expect("bundled producer commands must have an object or boolean schema")
}

macro_rules! source_schema {
    ($kind:ty, $pointer:literal) => {
        impl JsonSchema for $kind {
            fn schema_name() -> Cow<'static, str> {
                stringify!($kind).into()
            }

            fn schema_id() -> Cow<'static, str> {
                concat!(module_path!(), "::", stringify!($kind)).into()
            }

            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                command_schema($pointer)
            }
        }
    };
}

source_schema!(EngineCommand, "/schemas/methods/execute/args");
source_schema!(
    GoalCommand,
    "/schemas/methods/execute/args/properties/command"
);

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::{GoalGrant, ModelChoice, ModelChoices, ModelReference};
    use serde_json::json;

    #[test]
    fn command_representation() {
        let schema = schemars::schema_for!(EngineCommand).to_value();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let command = EngineCommand {
            version: 1,
            request_id: "request".into(),
            command: GoalCommand::submit(
                "Inspect the workspace".into(),
                vec![],
                GoalGrant {
                    id: "grant".into(),
                    version: 1,
                },
            ),
        };
        let original = serde_json::to_value(&command).unwrap();
        assert!(validator.is_valid(&original));
        let mut invalid = original.clone();
        invalid["command"]["grant"]["version"] = json!(9_007_199_254_740_992_u64);
        assert!(!validator.is_valid(&invalid));
        assert!(
            serde_json::from_value::<EngineCommand>(invalid)
                .unwrap()
                .command
                .validate()
                .is_err()
        );
        let mut invalid = original.clone();
        invalid["command"]["unrecognized"] = json!(true);
        assert!(!validator.is_valid(&invalid));
        assert!(serde_json::from_value::<EngineCommand>(invalid).is_err());
        let mut invalid = original;
        invalid["command"]["grant"]["version"] = json!(1.5);
        assert!(!validator.is_valid(&invalid));
    }

    #[test]
    fn continuation_contract() {
        let schema = schemars::schema_for!(GoalCommand).to_value();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let mut command = json!({
            "kind":"goal.submit", "objective":"Continue inspection", "completionCriteria":[],
            "grant":{"id":"grant","version":1},
            "continuation":{"goalId":"original","expectedVersion":1}
        });
        assert!(validator.is_valid(&command));
        assert!(
            serde_json::from_value::<GoalCommand>(command.clone())
                .unwrap()
                .validate()
                .is_ok()
        );
        command["continuation"]["expectedVersion"] = json!(0);
        assert!(!validator.is_valid(&command));
        assert!(
            serde_json::from_value::<GoalCommand>(command)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn serialized_catalog() {
        let catalog = ModelChoices {
            models: vec![ModelChoice {
                provider: "fixture".into(),
                model_id: "fixture".into(),
                name: "Fixture".into(),
                context_window: 1,
                images: false,
                thinking_levels: vec![],
            }],
            current: Some(ModelReference {
                provider: "fixture".into(),
                model_id: "fixture".into(),
            }),
        };
        let schema = schemars::schema_for!(ModelChoices).to_value();
        let value = serde_json::to_value(catalog).unwrap();
        assert!(jsonschema::validator_for(&schema).unwrap().is_valid(&value));
        assert_eq!(value["models"][0]["modelId"], "fixture");
    }
}
