//! Check user config files: `~/.silver/config.json`,
//! `./silver.json`, and any file referenced by
//! `SILVER_CONFIG`.

use std::env;
use std::path::PathBuf;

use super::helpers::parse_json_file;
use super::{Check, Status};

pub(super) fn check(checks: &mut Vec<Check>) {
    let category = "Config";

    let user_path = dirs::home_dir().map(|d| d.join(".silver").join("config.json"));
    if let Some(p) = user_path {
        if p.exists() {
            match parse_json_file(&p) {
                Ok(_) => checks.push(Check::new(
                    "config.user",
                    category,
                    Status::Pass,
                    format!("{} (valid JSON)", p.display()),
                )),
                Err(e) => checks.push(
                    Check::new(
                        "config.user",
                        category,
                        Status::Fail,
                        format!("{}: {}", p.display(), e),
                    )
                    .with_fix(format!("edit {}", p.display())),
                ),
            }
        }
    }

    let project_path = PathBuf::from("silver.json");
    if project_path.exists() {
        match parse_json_file(&project_path) {
            Ok(_) => checks.push(Check::new(
                "config.project",
                category,
                Status::Pass,
                format!("{} (valid JSON)", project_path.display()),
            )),
            Err(e) => checks.push(
                Check::new(
                    "config.project",
                    category,
                    Status::Fail,
                    format!("{}: {}", project_path.display(), e),
                )
                .with_fix(format!("edit {}", project_path.display())),
            ),
        }
    }

    if let Ok(custom) = env::var("SILVER_CONFIG") {
        let p = PathBuf::from(&custom);
        if !p.exists() {
            checks.push(
                Check::new(
                    "config.custom",
                    category,
                    Status::Fail,
                    format!("SILVER_CONFIG points to missing file: {}", custom),
                )
                .with_fix("update or unset SILVER_CONFIG"),
            );
        } else {
            match parse_json_file(&p) {
                Ok(_) => checks.push(Check::new(
                    "config.custom",
                    category,
                    Status::Pass,
                    format!("SILVER_CONFIG: {} (valid JSON)", custom),
                )),
                Err(e) => checks.push(
                    Check::new(
                        "config.custom",
                        category,
                        Status::Fail,
                        format!("SILVER_CONFIG: {}: {}", custom, e),
                    )
                    .with_fix(format!("edit {}", custom)),
                ),
            }
        }
    }
}
