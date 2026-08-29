//! Issues d'authentification : qui a essayé d'entrer, et depuis où.
//!
//! On remonte des issues (tentative réussie ou échouée, adresse, compte visé),
//! jamais l'activité d'une session : les journaux lus ici contiennent commandes
//! sudo, services démarrés, chemins ouverts, et rien de cela ne sort de la
//! machine. Ce module n'émet que des compteurs plus deux listes bornées.
//!
//! Chaque relevé part de la fin du précédent : les fenêtres sont additives côté
//! serveur, aucune tentative n'est comptée deux fois ni perdue.

use std::collections::HashMap;

use serde::Serialize;

/// Plafonds, alignés sur `AUTH_SOURCE_LIMIT` / `AUTH_LOGIN_LIMIT` côté serveur.
const MAX_SOURCES: usize = 50;
const MAX_LOGINS: usize = 50;

/// Lignes lues au maximum par relevé : une machine sous balayage produit des
/// dizaines de milliers de lignes d'échec par heure, et un journal entier ne
/// doit jamais être chargé en mémoire.
const MAX_LINES: usize = 20_000;

/// Une adresse et ce qu'elle a tenté.
#[derive(Debug, Clone, Serialize)]
pub struct AuthSource {
    pub address: String,
    pub failed: u32,
    pub accepted: u32,
    /// Comptes **visés**. Savoir qu'une adresse a essayé `root`, puis `admin`,
    /// puis `oracle` est ce qui distingue un balayage d'une erreur de frappe.
    pub users: Vec<String>,
}

/// Une authentification réussie — le seul événement nominatif qu'on remonte.
#[derive(Debug, Clone, Serialize)]
pub struct AuthLogin {
    pub user: String,
    pub address: Option<String>,
    pub method: Option<String>,
    pub at: i64,
}

/// La fenêtre. Miroir d'`authWindowSchema`.
#[derive(Debug, Clone, Serialize)]
pub struct AuthWindow {
    pub from: i64,
    pub to: i64,
    pub failed: u32,
    pub accepted: u32,
    #[serde(rename = "invalidUser")]
    pub invalid_user: u32,
    /// Nombre d'élévations sudo, **sans** les commandes exécutées.
    pub sudo: u32,
    #[serde(rename = "newAccounts")]
    pub new_accounts: Vec<String>,
    #[serde(rename = "rootLogins")]
    pub root_logins: u32,
    #[serde(rename = "topSources")]
    pub top_sources: Vec<AuthSource>,
    pub logins: Vec<AuthLogin>,
    /// La source n'a pas pu être lue : distingue « zéro tentative » de « je
    /// n'ai pas pu regarder », sans quoi une machine aveugle passerait pour
    /// une machine tranquille.
    pub unavailable: bool,
}

/// Accumule les lignes analysées avant d'en faire une fenêtre.
#[derive(Default)]
struct Tally {
    failed: u32,
    accepted: u32,
    invalid_user: u32,
    sudo: u32,
    root_logins: u32,
    new_accounts: Vec<String>,
    sources: HashMap<String, AuthSource>,
    logins: Vec<AuthLogin>,
}

impl Tally {
    fn source(&mut self, address: &str) -> &mut AuthSource {
        self.sources
            .entry(address.to_string())
            .or_insert_with(|| AuthSource {
                address: address.to_string(),
                failed: 0,
                accepted: 0,
                users: Vec::new(),
            })
    }

    fn note_user(&mut self, address: &str, user: &str) {
        let src = self.source(address);
        if !user.is_empty() && !src.users.iter().any(|u| u == user) && src.users.len() < 16 {
            src.users.push(user.to_string());
        }
    }
}

/// Relève la fenêtre `[from, now]`. Ne lève jamais.
///
/// `from` est la fin du relevé précédent, en unix ms ; `0` au premier passage,
/// auquel cas on se limite à la dernière heure : rejouer un journal entier
/// produirait un pic de constats sur des tentatives vieilles de plusieurs mois.
pub fn collect(from: i64) -> AuthWindow {
    let now = now_millis();
    let from = if from <= 0 {
        now - 3_600_000
    } else {
        from.min(now)
    };

    let Some(lines) = read_lines(from) else {
        return AuthWindow {
            from,
            to: now,
            failed: 0,
            accepted: 0,
            invalid_user: 0,
            sudo: 0,
            new_accounts: Vec::new(),
            root_logins: 0,
            top_sources: Vec::new(),
            logins: Vec::new(),
            unavailable: true,
        };
    };

    let mut tally = Tally::default();
    for line in lines.iter().take(MAX_LINES) {
        parse_line(line, now, &mut tally);
    }

    let mut sources: Vec<AuthSource> = tally.sources.into_values().collect();
    // Les plus insistantes d'abord : c'est la seule question qu'on pose à cette
    // liste, et elle est tronquée.
    sources.sort_by(|a, b| b.failed.cmp(&a.failed).then(b.accepted.cmp(&a.accepted)));
    sources.truncate(MAX_SOURCES);

    let mut logins = tally.logins;
    // Les plus récentes : une réussite d'il y a cinquante minutes intéresse
    // moins que celle d'il y a deux.
    logins.reverse();
    logins.truncate(MAX_LOGINS);

    AuthWindow {
        from,
        to: now,
        failed: tally.failed,
        accepted: tally.accepted,
        invalid_user: tally.invalid_user,
        sudo: tally.sudo,
        new_accounts: tally.new_accounts,
        root_logins: tally.root_logins,
        top_sources: sources,
        logins,
        unavailable: false,
    }
}

/// Analyse une ligne de journal.
///
/// Volontairement tolérante : les formats varient d'une distribution et d'une
/// version d'OpenSSH à l'autre, et une ligne non reconnue ne coûte qu'un compteur
/// non incrémenté. Rater une tentative vaut mieux qu'en inventer une.
fn parse_line(line: &str, now: i64, tally: &mut Tally) {
    // `Failed password for invalid user oracle from 1.2.3.4 port 51234 ssh2`
    // `Failed password for root from 1.2.3.4 port 51234 ssh2`
    if line.contains("Failed password") || line.contains("Failed publickey") {
        tally.failed += 1;
        let invalid = line.contains("invalid user");
        if invalid {
            tally.invalid_user += 1;
        }
        if let Some((user, addr)) = user_and_address(line) {
            tally.source(&addr).failed += 1;
            tally.note_user(&addr, &user);
        }
        return;
    }

    // `Invalid user admin from 1.2.3.4 port 51234` — le balayage qui ne prend
    // même pas la peine d'essayer un mot de passe.
    if line.contains("Invalid user") {
        tally.failed += 1;
        tally.invalid_user += 1;
        if let Some((user, addr)) = user_and_address(line) {
            tally.source(&addr).failed += 1;
            tally.note_user(&addr, &user);
        }
        return;
    }

    // `Accepted publickey for deploy from 1.2.3.4 port 51234 ssh2: RSA SHA256:…`
    if line.contains("Accepted ") {
        tally.accepted += 1;
        let method = line
            .split("Accepted ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_string);
        if let Some((user, addr)) = user_and_address(line) {
            tally.source(&addr).accepted += 1;
            tally.note_user(&addr, &user);
            if user == "root" {
                tally.root_logins += 1;
            }
            tally.logins.push(AuthLogin {
                user,
                address: Some(addr),
                method,
                at: now,
            });
        }
        return;
    }

    // `sudo: gerem : TTY=pts/0 ; PWD=/home ; USER=root ; COMMAND=/bin/ls`
    // On compte, et rien d'autre : la commande ne sort pas de la machine.
    if line.contains("sudo:") && line.contains("COMMAND=") {
        tally.sudo += 1;
        return;
    }

    // `useradd[1234]: new user: name=backdoor, UID=0, …`
    if line.contains("new user:") || line.contains("new group:") {
        if let Some(name) = line
            .split("name=")
            .nth(1)
            .and_then(|rest| rest.split(&[',', ' '][..]).next())
        {
            let name = name.trim().to_string();
            if !name.is_empty()
                && !tally.new_accounts.contains(&name)
                && tally.new_accounts.len() < 16
            {
                tally.new_accounts.push(name);
            }
        }
    }
}

/// Extrait `(compte visé, adresse source)` d'une ligne sshd.
///
/// La structure est stable depuis très longtemps : `… for [invalid user] <user>
/// from <addr> port <n>`. On s'appuie sur les mots-clés `for` et `from` plutôt
/// que sur des positions, qui varient avec le préfixe syslog et le format de date.
fn user_and_address(line: &str) -> Option<(String, String)> {
    let after_for = line.split(" for ").nth(1)?;
    let after_for = after_for.strip_prefix("invalid user ").unwrap_or(after_for);
    let user = after_for.split_whitespace().next()?.to_string();
    let addr = line
        .split(" from ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .to_string();
    if user.is_empty() || addr.is_empty() {
        return None;
    }
    Some((user, addr))
}

/// Lit les lignes d'authentification depuis `from` (unix ms). `None` = illisible.
#[cfg(target_os = "linux")]
fn read_lines(from: i64) -> Option<Vec<String>> {
    use crate::report::run_timeout;
    use std::time::Duration;

    let since = format!("@{}", from / 1000);
    // journald d'abord : filtrage natif par date et par unité, donc on ne lit
    // que ce qui nous concerne au lieu de parcourir un fichier entier.
    if let Some(out) = run_timeout(
        "journalctl",
        &[
            "--since",
            &since,
            "-t",
            "sshd",
            "-t",
            "sudo",
            "-t",
            "useradd",
            "-o",
            "cat",
            "--no-pager",
        ],
        Duration::from_secs(15),
    ) {
        if out.success {
            return Some(out.stdout.lines().map(str::to_string).collect());
        }
    }

    // Sans journald : les fichiers classiques. Pas de filtrage par date (leur
    // horodatage n'a pas d'année), donc on lit la queue et le serveur absorbe le
    // recouvrement ; une fenêtre trouée perdrait des tentatives.
    for path in ["/var/log/auth.log", "/var/log/secure"] {
        if let Ok(text) = std::fs::read_to_string(path) {
            let lines: Vec<String> = text.lines().map(str::to_string).collect();
            let start = lines.len().saturating_sub(MAX_LINES);
            return Some(lines[start..].to_vec());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_lines(from: i64) -> Option<Vec<String>> {
    use crate::report::run_timeout;
    use std::time::Duration;

    // `log show` veut une durée, pas une date : on la dérive de la fenêtre.
    let minutes = ((now_millis() - from) / 60_000).clamp(1, 1440);
    let last = format!("{minutes}m");
    let out = run_timeout(
        "log",
        &[
            "show",
            "--last",
            &last,
            "--style",
            "compact",
            "--predicate",
            "process == \"sshd\" OR process == \"sudo\"",
        ],
        Duration::from_secs(20),
    )?;
    out.success
        .then(|| out.stdout.lines().map(str::to_string).collect())
}

#[cfg(target_os = "windows")]
fn read_lines(from: i64) -> Option<Vec<String>> {
    use crate::report::run_timeout;
    use std::time::Duration;

    // 4625 échec, 4624 réussite, 4720 création de compte, 4728 ajout à un groupe.
    let minutes = ((now_millis() - from) / 60_000).clamp(1, 1440);
    let script = format!(
        "Get-WinEvent -FilterHashtable @{{LogName='Security'; Id=4624,4625,4720,4728; \
         StartTime=(Get-Date).AddMinutes(-{minutes})}} -ErrorAction SilentlyContinue | \
         ForEach-Object {{ $_.Message -replace '\\r?\\n',' ' }}"
    );
    let out = run_timeout(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        Duration::from_secs(25),
    )?;
    out.success
        .then(|| out.stdout.lines().map(str::to_string).collect())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_lines(_from: i64) -> Option<Vec<String>> {
    None
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tally_of(lines: &[&str]) -> Tally {
        let mut t = Tally::default();
        for l in lines {
            parse_line(l, 1_700_000_000_000, &mut t);
        }
        t
    }

    #[test]
    fn counts_failed_passwords_per_source() {
        let t = tally_of(&[
            "Failed password for root from 1.2.3.4 port 51234 ssh2",
            "Failed password for root from 1.2.3.4 port 51235 ssh2",
            "Failed password for invalid user oracle from 5.6.7.8 port 40000 ssh2",
        ]);
        assert_eq!(t.failed, 3);
        assert_eq!(t.invalid_user, 1, "seul `invalid user` compte comme tel");
        assert_eq!(t.sources["1.2.3.4"].failed, 2);
        assert_eq!(t.sources["5.6.7.8"].failed, 1);
        assert_eq!(
            t.sources["5.6.7.8"].users,
            vec!["oracle"],
            "le compte visé, pas le préfixe"
        );
    }

    #[test]
    fn records_accepted_logins_with_method() {
        let t =
            tally_of(&["Accepted publickey for deploy from 10.0.0.9 port 22 ssh2: RSA SHA256:abc"]);
        assert_eq!(t.accepted, 1);
        assert_eq!(t.root_logins, 0);
        assert_eq!(t.logins.len(), 1);
        assert_eq!(t.logins[0].user, "deploy");
        assert_eq!(t.logins[0].address.as_deref(), Some("10.0.0.9"));
        assert_eq!(t.logins[0].method.as_deref(), Some("publickey"));
    }

    /// Une session root ouverte directement ne laisse aucune trace nominative :
    /// c'est ce qui en fait un constat à part entière.
    #[test]
    fn flags_direct_root_logins() {
        let t = tally_of(&["Accepted password for root from 10.0.0.9 port 22 ssh2"]);
        assert_eq!(t.root_logins, 1);
    }

    /// La ligne sudo porte la commande complète. On compte l'élévation et on
    /// n'emporte rien d'autre — c'est la frontière de la feature.
    #[test]
    fn sudo_is_counted_never_detailed() {
        let t = tally_of(&[
            "sudo: gerem : TTY=pts/0 ; PWD=/home/gerem ; USER=root ; COMMAND=/bin/cat /etc/shadow",
        ]);
        assert_eq!(t.sudo, 1);
        assert!(t.logins.is_empty(), "sudo n'est pas une connexion");
        assert!(t.sources.is_empty(), "et ne porte pas d'adresse");
    }

    #[test]
    fn detects_account_creation() {
        let t = tally_of(&["useradd[4242]: new user: name=backdoor, UID=0, GID=0, home=/root"]);
        assert_eq!(t.new_accounts, vec!["backdoor"]);
    }

    /// IPv6 : l'adresse ne se devine pas à la position, seulement au mot-clé.
    #[test]
    fn parses_ipv6_sources() {
        let (user, addr) =
            user_and_address("Failed password for root from 2001:db8::1 port 51234 ssh2").unwrap();
        assert_eq!(user, "root");
        assert_eq!(addr, "2001:db8::1");
    }

    /// Une ligne qu'on ne reconnaît pas ne doit rien inventer.
    #[test]
    fn ignores_unrelated_lines() {
        let t = tally_of(&["Server listening on 0.0.0.0 port 22."]);
        assert_eq!(t.failed, 0);
        assert_eq!(t.accepted, 0);
        assert!(t.sources.is_empty());
    }

    /// Le relevé complet sur la machine qui exécute les tests : on vérifie la
    /// forme et les invariants, pas le contenu. `unavailable` et des compteurs
    /// non nuls sont mutuellement exclusifs.
    #[test]
    fn collect_yields_a_coherent_window() {
        let w = collect(0);
        assert!(w.to >= w.from, "la fenêtre ne peut pas être inversée");
        assert!(w.top_sources.len() <= MAX_SOURCES);
        assert!(w.logins.len() <= MAX_LOGINS);

        if w.unavailable {
            assert_eq!(w.failed, 0);
            assert_eq!(w.accepted, 0);
            assert!(w.top_sources.is_empty());
        }
        // Un échec compté par source ne peut pas dépasser le total.
        let per_source: u32 = w.top_sources.iter().map(|s| s.failed).sum();
        assert!(
            per_source <= w.failed,
            "la somme par adresse ({per_source}) dépasse le total ({})",
            w.failed
        );

        eprintln!(
            "fenêtre d'auth de cette machine : échecs={} réussites={} sudo={} illisible={}",
            w.failed, w.accepted, w.sudo, w.unavailable
        );
    }
}
