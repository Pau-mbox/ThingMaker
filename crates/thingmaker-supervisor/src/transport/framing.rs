//! Newline-delimited frame splitting with a hard per-line limit.
//!
//! Bytes are buffered until a newline so multi-byte UTF-8 sequences split
//! across reads are never decoded early. Multiple frames per read, partial
//! lines, CRLF and EOF during a frame are all handled. When a line exceeds the
//! limit the bytes are discarded and reported as an [`Frame::Overflow`] that
//! carries only sizes: a malformed or oversized frame may contain secrets and
//! is never logged verbatim (spec section 8.3).

use std::mem;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// One complete line without its terminator (trailing `\r` removed).
    Line(Vec<u8>),
    /// A line exceeded the limit; its bytes were dropped.
    Overflow { bytes: usize, limit: usize },
    /// Bytes remaining at EOF without a newline. Callers may attempt to parse
    /// them (a peer may exit right after a final frame) but must treat parse
    /// failure as "EOF during a frame".
    Tail(Vec<u8>),
}

#[derive(Debug)]
pub struct LineFramer {
    buffer: Vec<u8>,
    limit: usize,
    overflow_bytes: Option<usize>,
}

impl LineFramer {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            limit,
            overflow_bytes: None,
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    /// Bytes currently held for an incomplete line.
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        let mut rest = data;
        while !rest.is_empty() {
            match rest.iter().position(|byte| *byte == b'\n') {
                Some(position) => {
                    let (line_part, after) = rest.split_at(position);
                    rest = &after[1..];
                    if let Some(dropped) = self.overflow_bytes.take() {
                        frames.push(Frame::Overflow {
                            bytes: dropped + line_part.len(),
                            limit: self.limit,
                        });
                        continue;
                    }
                    if self.buffer.len() + line_part.len() > self.limit {
                        let dropped = self.buffer.len() + line_part.len();
                        self.buffer.clear();
                        frames.push(Frame::Overflow {
                            bytes: dropped,
                            limit: self.limit,
                        });
                        continue;
                    }
                    let mut line = mem::take(&mut self.buffer);
                    line.extend_from_slice(line_part);
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    frames.push(Frame::Line(line));
                }
                None => {
                    if let Some(dropped) = self.overflow_bytes.as_mut() {
                        *dropped += rest.len();
                    } else if self.buffer.len() + rest.len() > self.limit {
                        self.overflow_bytes = Some(self.buffer.len() + rest.len());
                        self.buffer.clear();
                    } else {
                        self.buffer.extend_from_slice(rest);
                    }
                    rest = &[];
                }
            }
        }
        frames
    }

    /// Call at EOF. Returns the dangling partial line, if any.
    pub fn finish(&mut self) -> Option<Frame> {
        if let Some(dropped) = self.overflow_bytes.take() {
            return Some(Frame::Overflow {
                bytes: dropped,
                limit: self.limit,
            });
        }
        if self.buffer.is_empty() {
            return None;
        }
        let tail = mem::take(&mut self.buffer);
        if tail.iter().all(u8::is_ascii_whitespace) {
            return None;
        }
        Some(Frame::Tail(tail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(frames: &[Frame]) -> Vec<String> {
        frames
            .iter()
            .map(|frame| match frame {
                Frame::Line(bytes) | Frame::Tail(bytes) => String::from_utf8(bytes.clone()).unwrap(),
                Frame::Overflow { bytes, limit } => format!("<overflow {bytes}/{limit}>"),
            })
            .collect()
    }

    #[test]
    fn splits_multiple_frames_per_read_and_keeps_partial_lines() {
        let mut framer = LineFramer::new(1024);
        let first = framer.feed(b"{\"a\":1}\n{\"b\":2}\n{\"c\":");
        assert_eq!(lines(&first), ["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(framer.buffered(), 5);
        let second = framer.feed(b"3}\r\n\n   \n");
        assert_eq!(lines(&second), ["{\"c\":3}"]);
        assert!(framer.finish().is_none());
    }

    #[test]
    fn utf8_split_across_reads_is_reassembled() {
        let mut framer = LineFramer::new(1024);
        let text = "{\"text\":\"héllo — ünïcode 🎉\"}\n";
        let bytes = text.as_bytes();
        // Split inside the multi-byte emoji.
        let emoji_start = text.find('🎉').unwrap();
        let split = emoji_start + 2;
        let mut frames = framer.feed(&bytes[..split]);
        assert!(frames.is_empty());
        frames.extend(framer.feed(&bytes[split..]));
        assert_eq!(lines(&frames), [text.trim_end()]);
    }

    #[test]
    fn oversized_line_is_dropped_and_reported_once_then_recovers() {
        let mut framer = LineFramer::new(8);
        let frames = framer.feed(b"0123456789abcdef");
        assert!(frames.is_empty());
        let frames = framer.feed(b"ghij\nok\n");
        assert_eq!(lines(&frames), ["<overflow 20/8>", "ok"]);
    }

    #[test]
    fn single_read_oversized_line_reports_total_bytes() {
        let mut framer = LineFramer::new(4);
        let frames = framer.feed(b"toolongline\nfine\n");
        assert_eq!(lines(&frames), ["<overflow 11/4>", "fine"]);
    }

    #[test]
    fn eof_during_frame_yields_tail() {
        let mut framer = LineFramer::new(1024);
        assert!(framer.feed(b"{\"id\":1,\"result\":{}}").is_empty());
        assert_eq!(framer.finish(), Some(Frame::Tail(b"{\"id\":1,\"result\":{}}".to_vec())));
        assert!(framer.finish().is_none());
    }

    #[test]
    fn eof_during_overflow_reports_overflow() {
        let mut framer = LineFramer::new(3);
        framer.feed(b"abcdef");
        assert_eq!(framer.finish(), Some(Frame::Overflow { bytes: 6, limit: 3 }));
    }
}
