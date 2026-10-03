//! End-to-end encrypted CloudSync shares, on the device side.
//!
//! The share secret (20 bytes) reaches the device sealed for this machine's
//! X25519 key and is never sent anywhere in clear. Three keys derive from it:
//! one names content (HMAC-SHA256 where a plain share uses SHA-256), one
//! encrypts the blocks of a blob, one is the check value the server keeps to
//! tell a mistyped recovery code.
//!
//! Blob format, DEVB v3 (the server stores it as is and cannot open it):
//!   'DEVB' | 0x03 | blob id (12) | block* | last block
//!   block = nonce (12, random) | ciphertext | tag (16)
//! Every block carries 1 MiB of plaintext except the last, which is always
//! present and always shorter. AAD = blob id | content name (32 raw bytes) |
//! index (8, big-endian) | last (1): a block cannot move to another rank,
//! another blob or another name, and a truncated blob does not open. The
//! browser (`DevEye-CloudSync/src/client/e2e.ts`) speaks the same format.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand::RngCore;
use ring::{aead, hkdf, hmac};
use sha2::{Digest, Sha256};
use tracing::warn;

/// Plaintext bytes per block.
pub const BLOCK: usize = 1024 * 1024;
pub const HEADER_LEN: usize = 17;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
/// A full block as stored.
pub const SEALED_FULL: usize = NONCE_LEN + BLOCK + TAG_LEN;
const MAGIC: &[u8; 4] = b"DEVB";
const VERSION: u8 = 0x03;
/// Length of the share secret, the recovery code the user writes down.
pub const SECRET_LEN: usize = 20;
/// A wrapped secret: ephemeral public key | nonce | ciphertext + tag.
const WRAPPED_LEN: usize = 32 + NONCE_LEN + SECRET_LEN + TAG_LEN;

const INFO_CONTENT: &[u8] = b"deveye-cloudsync/content/v1";
const INFO_NAMING: &[u8] = b"deveye-cloudsync/hash/v1";
const INFO_CHECK: &[u8] = b"deveye-cloudsync/check/v1";
const INFO_WRAP: &[u8] = b"deveye-cloudsync/wrap/v1";

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf32(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(ikm);
    let info = [info];
    let okm = prk
        .expand(&info, Len(32))
        .expect("32 bytes is a valid HKDF-SHA256 output");
    let mut out = [0u8; 32];
    okm.fill(&mut out).expect("same length as requested");
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The 32 raw bytes of a content name (64 hex digits).
pub fn name_bytes(hash: &str) -> Result<[u8; 32]> {
    if hash.len() != 64 {
        bail!("nom de contenu invalide");
    }
    let mut out = [0u8; 32];
    for (i, pair) in hash.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(pair).map_err(|_| anyhow!("nom de contenu invalide"))?;
        out[i] = u8::from_str_radix(text, 16).map_err(|_| anyhow!("nom de contenu invalide"))?;
    }
    Ok(out)
}

pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    nonce
}

/// The keys of one encrypted share, derived from its secret.
pub struct ShareKeys {
    content: aead::LessSafeKey,
    naming: hmac::Key,
    check: [u8; 32],
}

impl ShareKeys {
    pub fn from_secret(secret: &[u8]) -> Self {
        let content = hkdf32(&[], secret, INFO_CONTENT);
        let naming = hkdf32(&[], secret, INFO_NAMING);
        Self {
            content: aead::LessSafeKey::new(
                aead::UnboundKey::new(&aead::AES_256_GCM, &content).expect("32-byte AES key"),
            ),
            naming: hmac::Key::new(hmac::HMAC_SHA256, &naming),
            check: hkdf32(&[], secret, INFO_CHECK),
        }
    }

    /// What the index cache records of the naming key: hashes computed under
    /// another one name nothing this share holds.
    pub fn scheme(&self) -> String {
        format!("hmac:{}", hex(&self.check[..8]))
    }

    #[cfg(test)]
    pub fn check_hex(&self) -> String {
        hex(&self.check)
    }

    fn aad(blob_id: &[u8; 12], name: &[u8; 32], index: u64, last: bool) -> [u8; 53] {
        let mut aad = [0u8; 53];
        aad[..12].copy_from_slice(blob_id);
        aad[12..44].copy_from_slice(name);
        aad[44..52].copy_from_slice(&index.to_be_bytes());
        aad[52] = u8::from(last);
        aad
    }

    /// Seals one block under `nonce`: `nonce | ciphertext | tag`.
    pub fn seal_block(
        &self,
        blob_id: &[u8; 12],
        name: &[u8; 32],
        index: u64,
        last: bool,
        nonce: [u8; NONCE_LEN],
        plain: &[u8],
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(NONCE_LEN + plain.len() + TAG_LEN);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(plain);
        let tag = self
            .content
            .seal_in_place_separate_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(Self::aad(blob_id, name, index, last)),
                &mut out[NONCE_LEN..],
            )
            .expect("AES-GCM seals any block of this size");
        out.extend_from_slice(tag.as_ref());
        out
    }

    /// Opens one sealed block. Fails when the key, the rank, the blob, the
    /// name, the last-block mark or a single byte differs.
    pub fn open_block(
        &self,
        blob_id: &[u8; 12],
        name: &[u8; 32],
        index: u64,
        last: bool,
        sealed: &[u8],
    ) -> Result<Vec<u8>> {
        if sealed.len() < NONCE_LEN + TAG_LEN {
            bail!("bloc chiffré tronqué");
        }
        let nonce: [u8; NONCE_LEN] = sealed[..NONCE_LEN].try_into().expect("checked length");
        let mut body = sealed[NONCE_LEN..].to_vec();
        let plain_len = self
            .content
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(Self::aad(blob_id, name, index, last)),
                &mut body,
            )
            .map_err(|_| anyhow!("bloc chiffré invalide (clé, rang ou contenu)"))?
            .len();
        body.truncate(plain_len);
        Ok(body)
    }
}

/// How a share names content: plain SHA-256, or keyed by the share's secret.
#[derive(Clone)]
pub enum ContentHasher {
    Plain(Sha256),
    Keyed(hmac::Context),
}

impl ContentHasher {
    pub fn new(keys: Option<&ShareKeys>) -> Self {
        match keys {
            Some(k) => Self::Keyed(hmac::Context::with_key(&k.naming)),
            None => Self::Plain(Sha256::new()),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Plain(h) => h.update(data),
            Self::Keyed(h) => h.update(data),
        }
    }

    pub fn finish(self) -> String {
        match self {
            Self::Plain(h) => format!("{:x}", h.finalize()),
            Self::Keyed(h) => hex(h.sign().as_ref()),
        }
    }
}

/// The header of a new blob, with a random blob id.
pub fn new_header() -> [u8; HEADER_LEN] {
    let mut header = [0u8; HEADER_LEN];
    header[..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    rand::rngs::OsRng.fill_bytes(&mut header[5..]);
    header
}

/// The blob id of a v3 header.
pub fn parse_header(header: &[u8]) -> Result<[u8; 12]> {
    if header.len() != HEADER_LEN || &header[..4] != MAGIC || header[4] != VERSION {
        bail!("en-tête de blob chiffré invalide");
    }
    Ok(header[5..].try_into().expect("checked length"))
}

/// Decrypts a v3 blob as it streams in, from block `first` on. Holds at most
/// one block and a frame: a full block is only known to be one once more
/// bytes follow it.
pub struct Unsealer {
    keys: Arc<ShareKeys>,
    name: [u8; 32],
    blob_id: Option<[u8; 12]>,
    index: u64,
    pending: Vec<u8>,
}

impl Unsealer {
    pub fn new(keys: Arc<ShareKeys>, name: [u8; 32], first: u64) -> Self {
        Self {
            keys,
            name,
            blob_id: None,
            index: first,
            pending: Vec::new(),
        }
    }

    /// Plaintext of every block the bytes so far complete.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        self.pending.extend_from_slice(data);
        let mut out = Vec::new();
        if self.blob_id.is_none() {
            if self.pending.len() < HEADER_LEN {
                return Ok(out);
            }
            self.blob_id = Some(parse_header(&self.pending[..HEADER_LEN])?);
            self.pending.drain(..HEADER_LEN);
        }
        let blob_id = self.blob_id.expect("set above");
        while self.pending.len() > SEALED_FULL {
            let plain = self.keys.open_block(
                &blob_id,
                &self.name,
                self.index,
                false,
                &self.pending[..SEALED_FULL],
            )?;
            out.extend_from_slice(&plain);
            self.pending.drain(..SEALED_FULL);
            self.index += 1;
        }
        Ok(out)
    }

    /// The last block: what remains must be exactly one, shorter than a full one.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        let Some(blob_id) = self.blob_id else {
            bail!("blob chiffré tronqué (en-tête absent)");
        };
        if self.pending.len() >= SEALED_FULL {
            bail!("blob chiffré tronqué (dernier bloc absent)");
        }
        let last = std::mem::take(&mut self.pending);
        self.keys
            .open_block(&blob_id, &self.name, self.index, true, &last)
    }
}

/// This machine's X25519 key pair. The private half lives next to the config,
/// readable by the agent's account alone.
pub struct DeviceKey {
    secret: [u8; 32],
    public: [u8; 32],
}

impl DeviceKey {
    /// Reads the key pair, or creates one. A file that is not a key is
    /// replaced: what was sealed for it was unreadable anyway, and the server
    /// learns of the new public key at once.
    pub fn load_or_create(path: &Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(raw) if raw.len() == 32 => {
                let secret: [u8; 32] = raw.try_into().expect("checked length");
                return Ok(Self::from_secret(secret));
            }
            Ok(_) => warn!(path = %path.display(), "sync: device key unreadable, replaced"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| format!("lecture de {}", path.display()));
            }
        }
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        if let Some(parent) = path.parent() {
            crate::config::private_dir(parent).ok();
        }
        crate::config::write_private(path, &secret)
            .with_context(|| format!("écriture de {}", path.display()))?;
        Ok(Self::from_secret(secret))
    }

    fn from_secret(secret: [u8; 32]) -> Self {
        let public = MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        Self { secret, public }
    }

    pub fn public_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.public)
    }

    /// The share secret sealed for this machine (see `wrap` in the browser's
    /// `e2e.ts`): X25519 with the sender's ephemeral key, HKDF salted by both
    /// public keys, AES-GCM bound to the share id.
    pub fn open_share_secret(&self, share_id: i64, wrapped: &str) -> Result<Vec<u8>> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(wrapped.as_bytes())
            .map_err(|_| anyhow!("clé du partage illisible"))?;
        if raw.len() != WRAPPED_LEN {
            bail!("clé du partage illisible");
        }
        let ephemeral: [u8; 32] = raw[..32].try_into().expect("checked length");
        let shared = MontgomeryPoint(ephemeral)
            .mul_clamped(self.secret)
            .to_bytes();
        if shared == [0u8; 32] {
            bail!("clé du partage illisible");
        }
        let mut salt = [0u8; 64];
        salt[..32].copy_from_slice(&ephemeral);
        salt[32..].copy_from_slice(&self.public);
        let key = aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, &hkdf32(&salt, &shared, INFO_WRAP))
                .expect("32-byte AES key"),
        );
        let nonce: [u8; NONCE_LEN] = raw[32..44].try_into().expect("checked length");
        let mut body = raw[44..].to_vec();
        let secret = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(format!("deveye-cloudsync/share/{share_id}")),
                &mut body,
            )
            .map_err(|_| {
                anyhow!("clé du partage scellée pour une autre clé d'appareil : redéposez-la depuis DevEye")
            })?;
        Ok(secret.to_vec())
    }
}

/// SHA-256 of the tags of sealed blocks laid end to end: what a resumed push
/// compares with the server's kept blocks.
pub struct TagDigest(Sha256);

impl TagDigest {
    pub fn new() -> Self {
        Self(Sha256::new())
    }

    pub fn add(&mut self, sealed: &[u8]) {
        self.0.update(&sealed[sealed.len() - TAG_LEN..]);
    }

    pub fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

#[cfg(test)]
pub(crate) fn seal_share_secret(
    device_public: &str,
    share_id: i64,
    secret: &[u8],
    ephemeral_secret: [u8; 32],
    nonce: [u8; NONCE_LEN],
) -> String {
    let device: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(device_public)
        .unwrap()
        .try_into()
        .unwrap();
    let ephemeral = MontgomeryPoint::mul_base_clamped(ephemeral_secret).to_bytes();
    let shared = MontgomeryPoint(device)
        .mul_clamped(ephemeral_secret)
        .to_bytes();
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&ephemeral);
    salt[32..].copy_from_slice(&device);
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &hkdf32(&salt, &shared, INFO_WRAP)).unwrap(),
    );
    let mut body = secret.to_vec();
    let tag = key
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(format!("deveye-cloudsync/share/{share_id}")),
            &mut body,
        )
        .unwrap();
    let mut out = ephemeral.to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    out.extend_from_slice(tag.as_ref());
    base64::engine::general_purpose::STANDARD.encode(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn x25519_matches_rfc_7748() {
        let alice: [u8; 32] =
            unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                .try_into()
                .unwrap();
        let bob_public: [u8; 32] =
            unhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
                .try_into()
                .unwrap();
        assert_eq!(
            hex(&MontgomeryPoint::mul_base_clamped(alice).to_bytes()),
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
        );
        assert_eq!(
            hex(&MontgomeryPoint(bob_public).mul_clamped(alice).to_bytes()),
            "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
        );
    }

    /// Produced by the browser code (`DevEye-CloudSync/src/client/e2e.ts`):
    /// both sides must derive, name and seal the same way, byte for byte.
    #[test]
    fn the_browser_vectors_hold() {
        let secret: Vec<u8> = (1..=SECRET_LEN as u8).collect();
        let device = DeviceKey::from_secret([0x42; 32]);
        assert_eq!(
            device.public_b64(),
            "EyxEK+AQ+9V+cmAzKKp25x/MwVA6riGTJ9FNnJmT9HI="
        );
        let keys = ShareKeys::from_secret(&secret);
        assert_eq!(
            keys.check_hex(),
            "45e43a1214a16e7634e22c1457a4fbeaa28e2bbfcbacbb406b0a503b732cb9f2"
        );
        let mut name = ContentHasher::new(Some(&keys));
        name.update(b"bonjour");
        assert_eq!(
            name.finish(),
            "a731b429ed03fea3b5b96bc906424546dab44acc8257ddaecba87626278bc230"
        );
        let wrapped = "Uzx9a1UtlgM5CsLj+GJPEAnJWALaWtVYaJmmyyhpdz+aG1y6NPXfKm5bNAMDjRWRHXrmY5wsYSeyZBTKdG/lm1USsm8LwYiqJO2VBfpS9XM=";
        assert_eq!(device.open_share_secret(12, wrapped).unwrap(), secret);
    }

    #[test]
    fn a_sealed_secret_opens_for_its_device_and_share_only() {
        let dir = tempfile::tempdir().unwrap();
        let device = DeviceKey::load_or_create(&dir.path().join("k")).unwrap();
        let again = DeviceKey::load_or_create(&dir.path().join("k")).unwrap();
        assert_eq!(
            device.public_b64(),
            again.public_b64(),
            "the key pair persists"
        );

        let secret = [7u8; SECRET_LEN];
        let wrapped = seal_share_secret(&device.public_b64(), 12, &secret, [3u8; 32], [9u8; 12]);
        assert_eq!(device.open_share_secret(12, &wrapped).unwrap(), secret);
        assert!(
            device.open_share_secret(13, &wrapped).is_err(),
            "bound to its share"
        );

        let other = DeviceKey::load_or_create(&dir.path().join("other")).unwrap();
        assert!(
            other.open_share_secret(12, &wrapped).is_err(),
            "bound to its device"
        );
    }

    #[test]
    fn a_file_that_is_not_a_key_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k");
        std::fs::write(&path, b"garbage").unwrap();
        let device = DeviceKey::load_or_create(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 32);
        assert_eq!(
            DeviceKey::load_or_create(&path).unwrap().public_b64(),
            device.public_b64()
        );
    }

    fn seal_all(keys: &ShareKeys, name: &[u8; 32], plain: &[u8]) -> Vec<u8> {
        let header = new_header();
        let blob_id = parse_header(&header).unwrap();
        let mut out = header.to_vec();
        let mut index = 0u64;
        let mut rest = plain;
        loop {
            let take = rest.len().min(BLOCK);
            let last = take < BLOCK;
            out.extend(keys.seal_block(&blob_id, name, index, last, random_nonce(), &rest[..take]));
            rest = &rest[take..];
            index += 1;
            if last {
                return out;
            }
        }
    }

    fn open_all(
        keys: &Arc<ShareKeys>,
        name: [u8; 32],
        sealed: &[u8],
        frame: usize,
    ) -> Result<Vec<u8>> {
        let mut unsealer = Unsealer::new(Arc::clone(keys), name, 0);
        let mut out = Vec::new();
        for part in sealed.chunks(frame) {
            out.extend(unsealer.push(part)?);
        }
        out.extend(unsealer.finish()?);
        Ok(out)
    }

    #[test]
    fn blobs_round_trip_at_every_block_boundary() {
        let keys = Arc::new(ShareKeys::from_secret(&[1u8; SECRET_LEN]));
        let name = [5u8; 32];
        for size in [0, 1, BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK] {
            let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let sealed = seal_all(&keys, &name, &plain);
            let full = size / BLOCK;
            assert_eq!(
                sealed.len(),
                HEADER_LEN + full * SEALED_FULL + (size - full * BLOCK) + NONCE_LEN + TAG_LEN
            );
            assert_eq!(
                open_all(&keys, name, &sealed, 256 * 1024).unwrap(),
                plain,
                "{size}"
            );
        }
    }

    #[test]
    fn a_tampered_truncated_or_renamed_blob_does_not_open() {
        let keys = Arc::new(ShareKeys::from_secret(&[1u8; SECRET_LEN]));
        let name = [5u8; 32];
        let plain = vec![42u8; BLOCK + 10];
        let sealed = seal_all(&keys, &name, &plain);

        let mut flipped = sealed.clone();
        flipped[HEADER_LEN + 100] ^= 1;
        assert!(open_all(&keys, name, &flipped, 4096).is_err());

        // Without its last block, the first full one would have to pass as last.
        assert!(open_all(&keys, name, &sealed[..HEADER_LEN + SEALED_FULL], 4096).is_err());
        assert!(open_all(&keys, [6u8; 32], &sealed, 4096).is_err());
        let other = Arc::new(ShareKeys::from_secret(&[2u8; SECRET_LEN]));
        assert!(open_all(&other, name, &sealed, 4096).is_err());
    }

    #[test]
    fn keyed_names_differ_from_plain_and_between_shares() {
        let a = ShareKeys::from_secret(&[1u8; SECRET_LEN]);
        let b = ShareKeys::from_secret(&[2u8; SECRET_LEN]);
        let name = |keys: Option<&ShareKeys>| {
            let mut h = ContentHasher::new(keys);
            h.update(b"bonjour");
            h.finish()
        };
        assert_eq!(
            name(None),
            "2cb4b1431b84ec15d35ed83bb927e27e8967d75f4bcd9cc4b25c8d879ae23e18"
        );
        assert_ne!(name(Some(&a)), name(None));
        assert_ne!(name(Some(&a)), name(Some(&b)));
        assert_eq!(name(Some(&a)).len(), 64);
    }
}
