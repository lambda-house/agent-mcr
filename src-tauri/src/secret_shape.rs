//! What looks like a credential in text an agent or a terminal produced
//! (MCR-124 M9, MCR-125). Defence in depth beside "no secrets" in the
//! guides: such text is kept on disk or pasted elsewhere. A refusal names the
//! place and never repeats the match.
//!
//! `cockpit::looks_secret` is this function (re-exported), so the cockpit
//! and Copy as task refuse the same shapes.

/// The prefixes of the tokens and keys this operator's tools use, followed by
/// enough token characters to be one, an AWS key id, a bearer token, and a
/// private key block.
pub fn looks_secret(s: &str) -> bool {
    let token = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_');
    let run = |rest: &str, ok: &dyn Fn(char) -> bool| rest.chars().take_while(|c| ok(*c)).count();
    const PREFIXES: [&str; 13] = ["xoxb-", "xoxp-", "xapp-", "ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_", "sk-ant-", "sk-proj-", "sk-svcacct-", "glpat-"];
    for (at, _) in s.char_indices() {
        let rest = &s[at..];
        // A word that starts here, not the middle of one
        let starts = s[..at].chars().next_back().is_none_or(|c| !token(c));
        if starts && PREFIXES.iter().any(|p| rest.starts_with(p) && run(&rest[p.len()..], &token) >= 16) {
            return true;
        }
        if starts && rest.starts_with("sk-") && run(&rest[3..], &|c: char| c.is_ascii_alphanumeric()) >= 20 {
            return true;
        }
        if starts && rest.starts_with("AKIA") && run(&rest[4..], &|c: char| c.is_ascii_uppercase() || c.is_ascii_digit()) >= 16 {
            return true;
        }
        if rest.starts_with("Bearer ") && run(&rest[7..], &|c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')) >= 20 {
            return true;
        }
    }
    s.contains("-----BEGIN") && s.contains("PRIVATE KEY")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake credentials, put together at run time so that no scanner takes this file for a leak.
    fn fakes() -> Vec<String> {
        let body = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        vec![
            ["xo", "xb-", "1234-", body].concat(),
            ["xa", "pp-", body].concat(),
            ["gh", "p_", body].concat(),
            ["git", "hub_pat_", body].concat(),
            ["sk", "-ant-", body].concat(),
            ["sk", "-", body].concat(),
            ["AK", "IA", "ABCDEFGHIJ234567"].concat(),
            ["Bear", "er ", body, ".", body].concat(),
            ["-----BEGIN RSA ", "PRIVATE KEY-----"].concat(),
            ["xo", "xp-", "1234-", body].concat(),
            ["gh", "o_", body].concat(),
            ["gh", "s_", body].concat(),
            ["gh", "u_", body].concat(),
            ["gh", "r_", body].concat(),
            ["gl", "pat-", body].concat(),
            ["sk", "-proj-", "Ab_cd-", body].concat(),
            ["sk", "-svcacct-", body].concat(),
        ]
    }

    #[test]
    fn credential_shapes_are_found_and_ordinary_words_are_not() {
        for secret in fakes() {
            assert!(looks_secret(&format!("use {secret} now")), "{secret}");
        }
        for fine in ["the ghp_ prefix of a token", "ask-anthropic", "AKIA keys rotate", "a Bearer token", "risk-free", "task-antelope-1234567890123456789"] {
            assert!(!looks_secret(fine), "{fine}");
        }
    }
}
