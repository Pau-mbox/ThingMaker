//! Versioned, transactional schema migrations.
//!
//! `PRAGMA user_version` is the schema version. Before applying migrations to
//! an existing file a consistent backup is taken next to it. A database whose
//! version is newer than this build refuses to open for writing instead of
//! guessing (F05, section 15.2).

use rusqlite::params;

use super::{Storage, now_unix_ms};

pub const SCHEMA_VERSION: i64 = 19;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
    /// A table rebuild: runs with foreign-key enforcement off (SQLite cannot
    /// drop a referenced table otherwise), then every reference is checked.
    rebuilds: bool,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("schema/0001_init.sql"),
        rebuilds: false,
    },
    Migration {
        version: 2,
        name: "review",
        sql: include_str!("schema/0002_review.sql"),
        rebuilds: false,
    },
    Migration {
        version: 3,
        name: "worktrees",
        sql: include_str!("schema/0003_worktrees.sql"),
        rebuilds: false,
    },
    Migration {
        version: 4,
        name: "artifacts",
        sql: include_str!("schema/0004_artifacts.sql"),
        rebuilds: false,
    },
    Migration {
        version: 5,
        name: "odyssey",
        sql: include_str!("schema/0005_odyssey.sql"),
        rebuilds: false,
    },
    Migration {
        version: 6,
        name: "odyssey_plan",
        sql: include_str!("schema/0006_odyssey_plan.sql"),
        rebuilds: false,
    },
    Migration {
        version: 7,
        name: "odyssey_amendments",
        sql: include_str!("schema/0007_odyssey_amendments.sql"),
        rebuilds: false,
    },
    Migration {
        version: 8,
        name: "odyssey_on_report",
        sql: include_str!("schema/0008_odyssey_on_report.sql"),
        rebuilds: false,
    },
    Migration {
        version: 9,
        name: "odyssey_dead_turn",
        sql: include_str!("schema/0009_odyssey_dead_turn.sql"),
        rebuilds: false,
    },
    Migration {
        version: 10,
        name: "amendment_retell",
        sql: include_str!("schema/0010_amendment_retell.sql"),
        rebuilds: false,
    },
    Migration {
        version: 11,
        name: "plan_path",
        sql: include_str!("schema/0011_plan_path.sql"),
        rebuilds: false,
    },
    Migration {
        version: 12,
        name: "run_quality",
        sql: include_str!("schema/0012_run_quality.sql"),
        rebuilds: false,
    },
    Migration {
        version: 13,
        name: "tasks",
        sql: include_str!("schema/0013_tasks.sql"),
        rebuilds: false,
    },
    Migration {
        version: 14,
        name: "replanning_inbox",
        sql: include_str!("schema/0014_replanning_inbox.sql"),
        rebuilds: false,
    },
    Migration {
        version: 15,
        name: "amendment_kind",
        sql: include_str!("schema/0015_amendment_kind.sql"),
        rebuilds: false,
    },
    Migration {
        version: 16,
        name: "providers",
        sql: include_str!("schema/0016_providers.sql"),
        rebuilds: false,
    },
    Migration {
        version: 17,
        name: "workers",
        sql: include_str!("schema/0017_workers.sql"),
        rebuilds: false,
    },
    Migration {
        version: 18,
        name: "gemini",
        sql: include_str!("schema/0018_gemini.sql"),
        rebuilds: true,
    },
    Migration {
        version: 19,
        name: "bigthing_engine",
        sql: include_str!("schema/0019_bigthing_engine.sql"),
        rebuilds: false,
    },
];

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(String),
    #[error("database schema version {found} is newer than supported version {supported}; open read-only or upgrade the application")]
    NewerSchema { found: i64, supported: i64 },
    #[error("database integrity check failed: {0}")]
    Integrity(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

pub(crate) fn migrate(storage: &mut Storage) -> Result<(), StorageError> {
    let current = storage.schema_version()?;
    if current > SCHEMA_VERSION {
        return Err(StorageError::NewerSchema {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    let pending: Vec<&Migration> = MIGRATIONS.iter().filter(|m| m.version > current).collect();
    if pending.is_empty() {
        return Ok(());
    }
    if current > 0
        && let Some(path) = storage.path().map(|p| p.to_path_buf())
    {
        let backup = path.with_extension(format!("v{current}.bak.db"));
        storage.backup_to(&backup)?;
    }
    for migration in pending {
        let conn = storage.conn_mut();
        if migration.rebuilds {
            // Outside any transaction: SQLite ignores this pragma inside one.
            conn.pragma_update(None, "foreign_keys", "OFF")?;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![migration.version, migration.name, now_unix_ms()],
        )?;
        tx.pragma_update(None, "user_version", migration.version)?;
        if migration.rebuilds {
            let broken: i64 = tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get(0))?;
            if broken > 0 {
                return Err(StorageError::Integrity(format!("migration {} left {broken} broken references", migration.name)));
            }
        }
        tx.commit()?;
        if migration.rebuilds {
            storage.conn_mut().pragma_update(None, "foreign_keys", "ON")?;
        }
    }
    let integrity = storage.integrity_check()?;
    if integrity != "ok" {
        return Err(StorageError::Integrity(integrity));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_migrates_to_current_version_and_reopens_idempotently() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("meta.db");
        {
            let storage = Storage::open(&path).unwrap();
            assert_eq!(storage.schema_version().unwrap(), SCHEMA_VERSION);
            let applied: i64 = storage
                .conn()
                .query_row("SELECT COUNT(*) FROM migrations", [], |row| row.get(0))
                .unwrap();
            assert_eq!(applied, MIGRATIONS.len() as i64);
            let mode: String = storage
                .conn()
                .pragma_query_value(None, "journal_mode", |row| row.get(0))
                .unwrap();
            assert_eq!(mode.to_lowercase(), "wal");
        }
        let storage = Storage::open(&path).unwrap();
        assert_eq!(storage.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(storage.integrity_check().unwrap(), "ok");
    }

    #[test]
    fn upgrading_an_older_database_takes_a_backup_first() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("old.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(include_str!("schema/0001_init.sql")).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let storage = Storage::open(&path).unwrap();
        assert_eq!(storage.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(path.with_extension("v1.bak.db").exists(), "pre-migration backup");
        let count: i64 = storage
            .conn()
            .query_row("SELECT COUNT(*) FROM review_baselines", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_version_5_database_with_a_goal_keeps_it_across_the_plan_migration() {
        // The plan columns were added after Big Thing shipped, so an existing
        // goal has to survive the upgrade and read back as "no document".
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v5.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for sql in [
                include_str!("schema/0001_init.sql"),
                include_str!("schema/0002_review.sql"),
                include_str!("schema/0003_worktrees.sql"),
                include_str!("schema/0004_artifacts.sql"),
                include_str!("schema/0005_odyssey.sql"),
            ] {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute("INSERT INTO environments (id, kind, label, created_at) VALUES ('e', 'local', 'this computer', 0)", []).unwrap();
            conn.execute(
                "INSERT INTO workspaces (id, environment_id, canonical_root, display_path, workspace_hash, created_at) VALUES ('w', 'e', '/p', '/p', 'hash', 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO odysseys (id, workspace_id, title, state, stop_condition, on_usage_reset, max_continuations, created_at, updated_at)
                 VALUES ('o1', 'w', 'Existing goal', 'running', 'goal_complete', 'notify_only', 10, 0, 0)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }

        let storage = Storage::open(&path).unwrap();
        assert_eq!(storage.schema_version().unwrap(), SCHEMA_VERSION);
        let goal = storage.odyssey_get("o1").unwrap().expect("the goal survived");
        assert_eq!(goal.title, "Existing goal");
        assert_eq!(goal.plan_source, None);
        assert_eq!(goal.plan_document_bytes, None);
        assert_eq!(storage.odyssey_plan_document("o1").unwrap(), None);
    }

    #[test]
    fn newer_schema_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("future.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5).unwrap();
        }
        let error = Storage::open(&path).unwrap_err();
        assert!(matches!(error, StorageError::NewerSchema { found, .. } if found == SCHEMA_VERSION + 5));
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let storage = Storage::open_in_memory().unwrap();
        let result = storage.conn().execute(
            "INSERT INTO workspaces (id, environment_id, canonical_root, display_path, workspace_hash, created_at) VALUES ('w', 'missing-env', '/x', '/x', 'w-1', 0)",
            [],
        );
        assert!(result.is_err());
    }
}
