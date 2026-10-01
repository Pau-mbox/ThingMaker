//! Integration configuration: instruction files and skills, read with
//! provenance and edited with preservation (spec section 14, CTX-01).

pub mod context;
pub mod edit;
pub mod skill_import;
pub mod skills;

pub use edit::write_config_checked;
pub use context::{ContextSources, InstructionFile, context_sources, instruction_chain};
pub use skill_import::{AppliedSkill, ImportPlan, ImportedSkill, RemovedSkill, annotate_collisions, apply_import, remove_skill, stage_import};
pub use skills::{SkillEntry, SkillFrontmatter, SkillScope, discover_skills, parse_frontmatter};
