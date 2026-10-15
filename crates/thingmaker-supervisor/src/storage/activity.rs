use super::{Storage, migrations::StorageError};
use crate::activity::FileActivity;
impl Storage {
    pub fn activity_files(&self, since: i64) -> Result<Vec<FileActivity>, StorageError> {
        let mut query = self.conn().prepare("SELECT value FROM activity_files WHERE touched_at >= ? ORDER BY touched_at DESC LIMIT 20000")?;
        let rows = query.query_map([since], |row| row.get::<_, String>(0))?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|v| serde_json::from_str(&v).ok())
            .collect())
    }
    pub fn activity_save(&self, file: &FileActivity) -> Result<(), StorageError> {
        let value = serde_json::to_string(file).unwrap_or_default();
        self.conn().execute("INSERT INTO activity_files(workspace_id,path,touched_at,value) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,path) DO UPDATE SET touched_at=excluded.touched_at,value=excluded.value", rusqlite::params![file.workspace_id,file.path,file.touched_at,value])?;
        self.conn().execute(
            "DELETE FROM activity_files WHERE touched_at < ?1",
            [file.touched_at - 7 * 24 * 60 * 60 * 1000],
        )?;
        self.conn().execute("DELETE FROM activity_files WHERE workspace_id=?1 AND path IN (SELECT path FROM activity_files WHERE workspace_id=?1 ORDER BY touched_at DESC LIMIT -1 OFFSET 5000)", [&file.workspace_id])?;
        Ok(())
    }
    pub fn activity_clear(&self) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM activity_files", [])?;
        Ok(())
    }
}
