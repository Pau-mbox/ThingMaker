//! Typed key/value settings (spec section 15.1 `settings` table).
//!
//! Values are JSON documents so the renderer and native side share one shape.
//! Scope separates global preferences from per-workspace overrides.

use rusqlite::{OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use super::{Storage, StorageError, now_unix_ms};

pub const GLOBAL_SCOPE: &str = "global";

impl Storage {
    pub fn setting_get<T: DeserializeOwned>(&self, key: &str, scope: &str) -> Result<Option<T>, StorageError> {
        let raw: Option<String> = self
            .conn()
            .query_row(
                "SELECT typed_value FROM settings WHERE key = ?1 AND scope = ?2",
                params![key, scope],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|error| StorageError::Invalid(format!("setting {key} is not valid JSON: {error}"))),
        }
    }

    pub fn setting_set<T: Serialize>(&self, key: &str, scope: &str, value: &T) -> Result<(), StorageError> {
        let text = serde_json::to_string(value).map_err(|error| StorageError::Invalid(error.to_string()))?;
        self.conn().execute(
            "INSERT INTO settings (key, scope, typed_value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key, scope) DO UPDATE SET typed_value = excluded.typed_value, updated_at = excluded.updated_at",
            params![key, scope, text, now_unix_ms()],
        )?;
        Ok(())
    }

    pub fn setting_delete(&self, key: &str, scope: &str) -> Result<(), StorageError> {
        self.conn()
            .execute("DELETE FROM settings WHERE key = ?1 AND scope = ?2", params![key, scope])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Prefs {
        enabled: bool,
        muted: Vec<String>,
    }

    #[test]
    fn settings_round_trip_and_scope() {
        let storage = Storage::open_in_memory().unwrap();
        assert_eq!(storage.setting_get::<Prefs>("notifications", GLOBAL_SCOPE).unwrap(), None);
        let prefs = Prefs { enabled: true, muted: vec!["w1".into()] };
        storage.setting_set("notifications", GLOBAL_SCOPE, &prefs).unwrap();
        assert_eq!(storage.setting_get::<Prefs>("notifications", GLOBAL_SCOPE).unwrap(), Some(prefs));
        assert_eq!(storage.setting_get::<Prefs>("notifications", "workspace:w1").unwrap(), None);
        storage.setting_set("notifications", GLOBAL_SCOPE, &Prefs { enabled: false, muted: vec![] }).unwrap();
        assert!(!storage.setting_get::<Prefs>("notifications", GLOBAL_SCOPE).unwrap().unwrap().enabled);
        storage.setting_delete("notifications", GLOBAL_SCOPE).unwrap();
        assert_eq!(storage.setting_get::<Prefs>("notifications", GLOBAL_SCOPE).unwrap(), None);
    }
}
