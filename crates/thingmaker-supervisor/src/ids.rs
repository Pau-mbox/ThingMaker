//! Identifier types shared with the renderer.
//!
//! 64-bit counters (attachment generations, event sequences) are serialized as
//! decimal strings so they survive JavaScript's 53-bit safe integer range
//! (spec section 20.1). At the ACP boundary wire types are used as-is; this
//! representation is for our IPC and SQLite layers only.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct DecimalId(pub u64);

impl DecimalId {
    pub fn next(self) -> Self {
        Self(self.0.wrapping_add(1))
    }
}

impl fmt::Display for DecimalId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for DecimalId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for DecimalId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Number(u64),
            Text(String),
        }
        match Repr::deserialize(deserializer)? {
            Repr::Number(value) => Ok(DecimalId(value)),
            Repr::Text(text) => text
                .parse::<u64>()
                .map(DecimalId)
                .map_err(|_| serde::de::Error::custom("decimal identifier must be an unsigned integer")),
        }
    }
}

/// Opaque handle to a live session attachment.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandle {
    /// The agent's durable session identifier.
    pub id: String,
    /// Incremented whenever the transport for this session is restarted.
    /// Late callbacks carrying an older generation are rejected.
    pub attachment_generation: DecimalId,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_ids_round_trip_as_strings_and_accept_numbers() {
        let big = DecimalId(u64::MAX);
        let json = serde_json::to_string(&big).unwrap();
        assert_eq!(json, "\"18446744073709551615\"");
        let back: DecimalId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, big);
        let from_number: DecimalId = serde_json::from_str("42").unwrap();
        assert_eq!(from_number, DecimalId(42));
        assert!(serde_json::from_str::<DecimalId>("\"-1\"").is_err());
    }
}
