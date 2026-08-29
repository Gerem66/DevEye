//! Empreinte d'un index de partage : `{nombre}.{octets}.{sha256hex}`.
//!
//! Elle répond à une seule question, posée par le serveur : « ce que l'agent
//! détient est-il exactement ce que je crois qu'il détient ? ». L'agent ne
//! conclut rien, il rapporte un fait sur lui-même.
//!
//! Le `mtime` est VOLONTAIREMENT absent : la baseline du serveur n'est réécrite
//! que lorsque le hash change (`refreshBaseline` dans `planner.ts`), donc un
//! simple `touch` laisserait la baseline désaccordée pour toujours et le chemin
//! rapide ne s'engagerait plus jamais, en silence. L'empreinte certifie un jeu
//! de contenus, dont le mtime ne fait pas partie.
//!
//! Le pli est un XOR des hachages par ligne, donc indépendant de l'ordre : un
//! tri obligerait Rust (ordre octet UTF-8) et TypeScript (ordre unité UTF-16) à
//! s'accorder hors BMP, ce qu'ils ne font pas. L'annulation par doublon est
//! impossible, les clés étant uniques des deux côtés.
//!
//! L'empreinte ne doit JAMAIS intégrer un digest de la config (exclusions,
//! chemin local) : les deux copies changeraient au même instant alors que les
//! jeux d'entrées diffèrent encore, une fausse égalité. L'invalidation
//! appartient au compteur du watcher (`SyncManager`).
//!
//! Le format est mot pour mot celui de `src/cloudSync/fingerprint.ts`, et le
//! vecteur de test est le même des deux côtés.

use sha2::{Digest, Sha256};

/// Miroir de `SYNC_FINGERPRINT_SEP` (DevEye-Types/src/domain/cloudSync.ts).
const SEP: char = '\u{1}';

/// Ce qu'une entrée apporte à l'empreinte, dans l'ordre des champs du protocole.
pub struct FingerprintEntry<'a> {
    pub rel_path: &'a str,
    pub kind: &'a str,
    pub hash: &'a str,
    pub size: u64,
    pub mode: Option<u32>,
}

/// Accumulateur : les lignes peuvent arriver dans n'importe quel ordre.
#[derive(Default)]
pub struct Fingerprint {
    count: u64,
    sum_size: u64,
    fold: [u8; 32],
}

impl Fingerprint {
    pub fn push(&mut self, e: &FingerprintEntry<'_>) {
        // `mode` absent devient -1, et jamais 0 : sous Windows le mode est
        // inconnu, et le confondre avec « aucune permission » ferait diverger
        // l'empreinte d'un agent Windows de celle d'un fichier réellement en 000.
        let mode = e.mode.map(|m| m as i64).unwrap_or(-1);
        let line = format!(
            "{}{SEP}{}{SEP}{}{SEP}{}{SEP}{}",
            e.rel_path, e.kind, e.hash, e.size, mode
        );
        let digest = Sha256::digest(line.as_bytes());
        for (slot, byte) in self.fold.iter_mut().zip(digest.iter()) {
            *slot ^= byte;
        }
        self.count += 1;
        // Saturant : un débordement en `--release` serait silencieux et rendrait
        // l'empreinte fausse plutôt que bruyante.
        self.sum_size = self.sum_size.saturating_add(e.size);
    }

    pub fn finish(&self) -> String {
        let mut hex = String::with_capacity(64);
        for b in self.fold {
            use std::fmt::Write as _;
            let _ = write!(hex, "{b:02x}");
        }
        format!("{}.{}.{}", self.count, self.sum_size, hex)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture PARTAGÉE avec `src/cloudSync/fingerprint.test.ts`. Les deux tests
    /// affirment la même chaîne : si l'un change, l'autre doit changer aussi, et
    /// c'est tout l'intérêt.
    fn fixture() -> Vec<(String, String, String, u64, Option<u32>)> {
        vec![
            (
                "a.txt".into(),
                "file".into(),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
                12,
                Some(0o644),
            ),
            (
                "dossier/b.bin".into(),
                "file".into(),
                "0000000000000000000000000000000000000000000000000000000000000001".into(),
                3400,
                None,
            ),
            (
                "vide".into(),
                "dir".into(),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
                0,
                Some(0o755),
            ),
        ]
    }

    fn compute(rows: &[(String, String, String, u64, Option<u32>)]) -> String {
        let mut fp = Fingerprint::default();
        for (rel_path, kind, hash, size, mode) in rows {
            fp.push(&FingerprintEntry {
                rel_path,
                kind,
                hash,
                size: *size,
                mode: *mode,
            });
        }
        fp.finish()
    }

    #[test]
    fn shared_vector_matches_the_server() {
        assert_eq!(
            compute(&fixture()),
            "3.3412.a97be5e146c26a2a249ed6477fa0e48c2f62faeac044bd00201197045b185b40"
        );
    }

    /// Deux relevés du même arbre donnent la même empreinte : c'est ce qui
    /// évite de réécrire la baseline du serveur à chaque scan. Un `touch` n'y
    /// change rien par construction, `FingerprintEntry` ne portant pas de date.
    #[test]
    fn two_scans_of_the_same_tree_agree() {
        let first = compute(&fixture());
        let mut same_tree_seen_later = fixture();
        same_tree_seen_later.rotate_left(1);
        assert_eq!(first, compute(&same_tree_seen_later));
    }

    #[test]
    fn the_order_does_not_matter() {
        let mut shuffled = fixture();
        shuffled.reverse();
        assert_eq!(compute(&fixture()), compute(&shuffled));
    }

    #[test]
    fn every_field_moves_the_fingerprint() {
        let base = compute(&fixture());
        for i in 0..5 {
            let mut rows = fixture();
            match i {
                0 => rows[0].0 = "autre.txt".into(),
                1 => rows[0].1 = "dir".into(),
                2 => {
                    rows[0].2 =
                        "0000000000000000000000000000000000000000000000000000000000000002".into()
                }
                3 => rows[0].3 = 13,
                _ => rows[0].4 = None,
            }
            assert_ne!(base, compute(&rows), "champ {i} invisible à l'empreinte");
        }
    }

    #[test]
    fn an_unknown_mode_is_not_a_zero_mode() {
        let mut none_mode = fixture();
        none_mode[0].4 = None;
        let mut zero_mode = fixture();
        zero_mode[0].4 = Some(0);
        assert_ne!(compute(&none_mode), compute(&zero_mode));
    }
}
