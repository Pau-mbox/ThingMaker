//! Content Credentials (C2PA) reader for generated PNGs.
//!
//! OpenAI's image backend embeds a signed C2PA manifest in every PNG it
//! returns (a `caBX` chunk holding JUMBF boxes with CBOR claims). The claim's
//! `c2pa.created` action carries a `softwareAgent` map naming the generating
//! model, for example `{name: "gpt-image", version: "2.0"}`. The response body
//! itself never names a model, and the ChatGPT subscription endpoint accepts
//! any `model` value without honouring it, so this manifest is the only
//! evidence of what actually produced an image.
//!
//! The manifest is not verified here (no signature check); the fields are
//! read as recorded and labelled as such. Only the small subset of CBOR that
//! these claims use is decoded, and anything unexpected yields `None` rather
//! than a guess.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentCredentials {
    /// `softwareAgent.name` of the creation action (the model family).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
    /// `softwareAgent.version` of the creation action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator_version: Option<String>,
    /// `claim_generator_info.name` (the service that signed the manifest).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_generator: Option<String>,
    /// `c2pa.created` action time as recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

impl ContentCredentials {
    /// "gpt-image 2.0", or None when no generator was recorded.
    pub fn generator_label(&self) -> Option<String> {
        match (&self.generator, &self.generator_version) {
            (Some(name), Some(version)) => Some(format!("{name} {version}")),
            (Some(name), None) => Some(name.clone()),
            _ => None,
        }
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Concatenated payload of every `caBX` chunk in a PNG, or None.
fn c2pa_chunk(png: &[u8]) -> Option<Vec<u8>> {
    if png.len() < 8 || png[..8] != PNG_SIGNATURE {
        return None;
    }
    let mut pos = 8;
    let mut out = Vec::new();
    while pos + 8 <= png.len() {
        let length = u32::from_be_bytes([png[pos], png[pos + 1], png[pos + 2], png[pos + 3]]) as usize;
        let kind = &png[pos + 4..pos + 8];
        let start = pos + 8;
        let end = start.checked_add(length)?;
        if end > png.len() {
            return None;
        }
        if kind == b"caBX" {
            out.extend_from_slice(&png[start..end]);
        }
        if kind == b"IEND" {
            break;
        }
        pos = end + 4; // skip CRC
    }
    (!out.is_empty()).then_some(out)
}

/// Minimal CBOR cursor: enough for text-keyed maps of text/int values.
struct Cbor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cbor<'a> {
    fn head(&mut self) -> Option<(u8, u64)> {
        let byte = *self.data.get(self.pos)?;
        self.pos += 1;
        let major = byte >> 5;
        let info = byte & 0x1f;
        let arg = match info {
            0..=23 => u64::from(info),
            24 => {
                let v = *self.data.get(self.pos)?;
                self.pos += 1;
                u64::from(v)
            }
            25 => {
                let s = self.data.get(self.pos..self.pos + 2)?;
                self.pos += 2;
                u64::from(u16::from_be_bytes([s[0], s[1]]))
            }
            26 => {
                let s = self.data.get(self.pos..self.pos + 4)?;
                self.pos += 4;
                u64::from(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
            }
            27 => {
                let s = self.data.get(self.pos..self.pos + 8)?;
                self.pos += 8;
                u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
            }
            _ => return None, // indefinite lengths are not used in these claims
        };
        Some((major, arg))
    }

    fn text(&mut self) -> Option<String> {
        let (major, len) = self.head()?;
        if major != 3 {
            return None;
        }
        let end = self.pos.checked_add(usize::try_from(len).ok()?)?;
        let s = std::str::from_utf8(self.data.get(self.pos..end)?).ok()?.to_string();
        self.pos = end;
        Some(s)
    }

    fn skip(&mut self) -> Option<()> {
        let (major, arg) = self.head()?;
        match major {
            0 | 1 => Some(()),
            2 | 3 => {
                self.pos = self.pos.checked_add(usize::try_from(arg).ok()?)?;
                (self.pos <= self.data.len()).then_some(())
            }
            4 => (0..arg).try_for_each(|_| self.skip()),
            5 => (0..arg).try_for_each(|_| self.skip().and_then(|_| self.skip())),
            6 => self.skip(),
            7 => {
                // simple values carry their payload in the head except floats
                Some(())
            }
            _ => None,
        }
    }

    /// Reads a map of text keys whose values are text, returning the pairs;
    /// non-text values are skipped.
    fn text_map(&mut self) -> Option<Vec<(String, String)>> {
        let (major, len) = self.head()?;
        if major != 5 {
            return None;
        }
        let mut out = Vec::new();
        for _ in 0..len {
            let key = self.text()?;
            let save = self.pos;
            match self.text() {
                Some(value) => out.push((key, value)),
                None => {
                    self.pos = save;
                    self.skip()?;
                }
            }
        }
        Some(out)
    }
}

fn find_key(haystack: &[u8], key: &str) -> Option<usize> {
    // A CBOR text string of this length is encoded as 0x60 | len for len < 24,
    // or 0x78 len for len < 256.
    let mut needle = Vec::with_capacity(key.len() + 2);
    if key.len() < 24 {
        needle.push(0x60 | key.len() as u8);
    } else {
        needle.push(0x78);
        needle.push(key.len() as u8);
    }
    needle.extend_from_slice(key.as_bytes());
    haystack.windows(needle.len()).position(|w| w == needle).map(|i| i + needle.len())
}

fn map_after_key(chunk: &[u8], key: &str) -> Option<Vec<(String, String)>> {
    let start = find_key(chunk, key)?;
    Cbor { data: chunk, pos: start }.text_map()
}

fn text_after_key(chunk: &[u8], key: &str) -> Option<String> {
    let start = find_key(chunk, key)?;
    let mut cursor = Cbor { data: chunk, pos: start };
    // The value may be wrapped in a tag (e.g. tag 0 for date-time strings).
    let save = cursor.pos;
    if let Some((6, _)) = cursor.head() {
        return cursor.text();
    }
    cursor.pos = save;
    cursor.text()
}

/// Reads the generator recorded in a PNG's Content Credentials, if any.
pub fn content_credentials(png: &[u8]) -> Option<ContentCredentials> {
    let chunk = c2pa_chunk(png)?;
    let agent = map_after_key(&chunk, "softwareAgent");
    let claim = map_after_key(&chunk, "claim_generator_info");
    let get = |pairs: &Option<Vec<(String, String)>>, key: &str| pairs.as_ref().and_then(|p| p.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()));
    let credentials = ContentCredentials {
        generator: get(&agent, "name"),
        generator_version: get(&agent, "version"),
        claim_generator: get(&claim, "name"),
        created: text_after_key(&chunk, "when"),
    };
    (credentials.generator.is_some() || credentials.claim_generator.is_some()).then_some(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_cabx(payload: &[u8]) -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        let mut chunk = |kind: &[u8], data: &[u8]| {
            png.extend_from_slice(&(data.len() as u32).to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(data);
            png.extend_from_slice(&[0, 0, 0, 0]);
        };
        chunk(b"IHDR", &[0; 13]);
        chunk(b"caBX", payload);
        chunk(b"IEND", &[]);
        png
    }

    #[test]
    fn reads_generator_from_a_manifest_fragment() {
        // Bytes as produced by OpenAI's Media Service (see module docs):
        // ... "softwareAgent" {name: "gpt-image", version: "2.0", digitalSourceType: "..."}
        let mut payload = Vec::new();
        payload.extend_from_slice(b"\x74claim_generator_info\xa2\x64name\x78\x18OpenAI Media Service API\x64icon\x60");
        payload.extend_from_slice(b"\x66action\x6cc2pa.created\x64when\xc0\x742026-09-09T00:00:00Z");
        payload.extend_from_slice(b"\x6dsoftwareAgent\xa3\x64name\x69gpt-image\x67version\x63" );
        payload.extend_from_slice(b"2.0\x71digitalSourceType\x78\x46http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
        let png = png_with_cabx(&payload);
        let credentials = content_credentials(&png).expect("manifest read");
        assert_eq!(credentials.generator.as_deref(), Some("gpt-image"));
        assert_eq!(credentials.generator_version.as_deref(), Some("2.0"));
        assert_eq!(credentials.claim_generator.as_deref(), Some("OpenAI Media Service API"));
        assert_eq!(credentials.created.as_deref(), Some("2026-09-09T00:00:00Z"));
        assert_eq!(credentials.generator_label().as_deref(), Some("gpt-image 2.0"));
    }

    #[test]
    fn png_without_manifest_or_non_png_yields_none() {
        assert!(content_credentials(&png_with_cabx(b"nothing here")).is_none());
        assert!(content_credentials(b"\x89PNG\r\n\x1a\n").is_none());
        assert!(content_credentials(b"GIF89a").is_none());
    }

    /// `THINGMAKER_C2PA_PNG=/path/to.png cargo test -- --ignored --nocapture real_png`
    #[test]
    #[ignore]
    fn real_png_report() {
        let Ok(path) = std::env::var("THINGMAKER_C2PA_PNG") else { return };
        let png = std::fs::read(path).unwrap();
        println!("{:?}", content_credentials(&png));
    }
}
