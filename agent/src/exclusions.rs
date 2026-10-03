//! Path exclusions of a walked folder (a CloudSync share, a backed-up folder),
//! matched against the path relative to that folder's root. Same semantics as
//! `@deveye/types` `pathExclusionProblem` on the server side:
//!  - `path`: exact relative path, a file or a folder prefix;
//!  - `name`: exact name of any path component;
//!  - `regex`: linear-time regular expression on the whole relative path.
//!
//! Case never counts: macOS and Windows do not tell `Thumbs.db` from
//! `thumbs.db`, and the server matches the same way.

use anyhow::{bail, Result};
use regex::Regex;
use tracing::warn;

use crate::protocol::PathExclusion;

/// Compilation cap of one pattern (patterns are bounded server-side).
const REGEX_SIZE_LIMIT: usize = 1 << 20;

#[derive(Default)]
pub struct CompiledExclusions {
    /// Lower-cased.
    paths: Vec<String>,
    /// Lower-cased.
    names: Vec<String>,
    regexes: Vec<Regex>,
}

impl CompiledExclusions {
    /// Lenient: a pattern that does not compile is logged and ignored. For a
    /// sync, where refusing the whole assignment would stop the share.
    pub fn compile(rows: &[PathExclusion]) -> Self {
        let mut out = Self::default();
        for row in rows {
            if let Err(e) = out.add(row) {
                warn!(kind = %row.kind, pattern = %row.pattern, error = %e, "exclusion ignored");
            }
        }
        out
    }

    /// Strict: a pattern that does not compile fails. For an archive, where
    /// ignoring it would put in what was meant to stay out.
    pub fn compile_strict(rows: &[PathExclusion]) -> Result<Self> {
        let mut out = Self::default();
        for row in rows {
            out.add(row)?;
        }
        Ok(out)
    }

    fn add(&mut self, row: &PathExclusion) -> Result<()> {
        match row.kind.as_str() {
            "path" => self.paths.push(row.pattern.to_lowercase()),
            "name" => self.names.push(row.pattern.to_lowercase()),
            "regex" => match regex::RegexBuilder::new(&row.pattern)
                .case_insensitive(true)
                .size_limit(REGEX_SIZE_LIMIT)
                .build()
            {
                Ok(re) => self.regexes.push(re),
                Err(e) => bail!("motif d'exclusion invalide « {} » : {e}", row.pattern),
            },
            other => bail!("genre d'exclusion inconnu « {other} »"),
        }
        Ok(())
    }

    pub fn matches(&self, rel_path: &str) -> bool {
        let lower = rel_path.to_lowercase();
        for p in &self.paths {
            if &lower == p || lower.starts_with(&format!("{p}/")) {
                return true;
            }
        }
        if !self.names.is_empty()
            && lower
                .split('/')
                .any(|seg| self.names.iter().any(|n| n == seg))
        {
            return true;
        }
        self.regexes.iter().any(|re| re.is_match(rel_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: &str, pattern: &str) -> PathExclusion {
        PathExclusion {
            kind: kind.to_string(),
            pattern: pattern.to_string(),
        }
    }

    #[test]
    fn each_kind_matches_its_own_way() {
        let ex = CompiledExclusions::compile_strict(&[
            rule("path", "build/cache"),
            rule("name", "node_modules"),
            rule("regex", r"\.log$"),
        ])
        .unwrap();
        assert!(ex.matches("build/cache"));
        assert!(ex.matches("build/cache/a.bin"));
        assert!(!ex.matches("build/cached"));
        assert!(ex.matches("app/node_modules/x/index.js"));
        assert!(ex.matches("var/app.log"));
        assert!(!ex.matches("src/main.rs"));
    }

    #[test]
    fn matching_ignores_case() {
        let ex = CompiledExclusions::compile_strict(&[
            rule("path", "Build/Cache"),
            rule("name", "Thumbs.db"),
            rule("regex", r"(^|/)~\$[^/]*(/|$)"),
        ])
        .unwrap();
        assert!(ex.matches("build/cache/a.bin"));
        assert!(ex.matches("BUILD/CACHE"));
        assert!(ex.matches("photos/thumbs.db"));
        assert!(ex.matches("photos/THUMBS.DB"));
        assert!(ex.matches("docs/~$rapport.docx"));
        assert!(!ex.matches("docs/rapport.docx"));
    }

    #[test]
    fn strict_refuses_what_lenient_skips() {
        let bad = [rule("regex", "(?=x)"), rule("name", ".git")];
        assert!(CompiledExclusions::compile_strict(&bad).is_err());
        let lenient = CompiledExclusions::compile(&bad);
        assert!(lenient.matches("repo/.git/HEAD"));
        assert!(CompiledExclusions::compile_strict(&[rule("glob", "*")]).is_err());
    }
}
