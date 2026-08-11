use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

const MARKER_END: u8 = 0x07;
const MAX_MARKER_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum IntegrationEvent {
    BootstrapReady,
    Ready {
        shell: String,
    },
    Unavailable,
    CommandStart {
        command: String,
    },
    Prompt {
        cwd: String,
        exit_code: i32,
        command: Option<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedItem {
    Data(Vec<u8>),
    Event(IntegrationEvent),
}

pub struct ShellIntegrationParser {
    marker_prefix: Vec<u8>,
    pending: Vec<u8>,
}

impl ShellIntegrationParser {
    pub fn new(nonce: &str) -> Self {
        Self {
            marker_prefix: format!("\x1b]633;Termexa;{nonce};").into_bytes(),
            pending: Vec::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ParsedItem> {
        self.pending.extend_from_slice(bytes);
        let mut items = Vec::new();

        loop {
            let Some(prefix_index) = find_subslice(&self.pending, &self.marker_prefix) else {
                let keep = partial_prefix_len(&self.pending, &self.marker_prefix);
                let visible_len = self.pending.len().saturating_sub(keep);
                push_data(&mut items, self.pending.drain(..visible_len).collect());
                break;
            };

            if prefix_index > 0 {
                push_data(&mut items, self.pending.drain(..prefix_index).collect());
            }

            let payload_start = self.marker_prefix.len();
            let Some(end_offset) = self.pending[payload_start..]
                .iter()
                .position(|byte| *byte == MARKER_END)
            else {
                if self.pending.len() > MAX_MARKER_BYTES {
                    push_data(
                        &mut items,
                        self.pending.drain(..self.marker_prefix.len()).collect(),
                    );
                    continue;
                }
                break;
            };
            if payload_start + end_offset > MAX_MARKER_BYTES {
                push_data(
                    &mut items,
                    self.pending.drain(..self.marker_prefix.len()).collect(),
                );
                continue;
            }
            let payload_end = payload_start + end_offset;
            let payload = self.pending[payload_start..payload_end].to_vec();
            self.pending.drain(..=payload_end);

            if let Some(event) = parse_payload(&payload) {
                items.push(ParsedItem::Event(event));
            }
        }

        items
    }

    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

fn parse_payload(payload: &[u8]) -> Option<IntegrationEvent> {
    let text = std::str::from_utf8(payload).ok()?;
    let mut parts = text.split(';');
    match parts.next()? {
        "B" => Some(IntegrationEvent::BootstrapReady),
        "H" => match parts.next()? {
            "bash" => Some(IntegrationEvent::Ready {
                shell: "bash".to_string(),
            }),
            "zsh" => Some(IntegrationEvent::Ready {
                shell: "zsh".to_string(),
            }),
            _ => Some(IntegrationEvent::Unavailable),
        },
        "C" => {
            let command = String::from_utf8(B64.decode(parts.next()?).ok()?).ok()?;
            (!command.trim().is_empty()).then_some(IntegrationEvent::CommandStart { command })
        }
        "P" => {
            let exit_code = parts.next()?.parse::<i32>().ok()?;
            let cwd = String::from_utf8(B64.decode(parts.next()?).ok()?).ok()?;
            let command = parts
                .next()
                .filter(|encoded| !encoded.is_empty())
                .and_then(|encoded| B64.decode(encoded).ok())
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|command| !command.trim().is_empty());
            Some(IntegrationEvent::Prompt {
                cwd,
                exit_code,
                command,
            })
        }
        _ => None,
    }
}

fn push_data(items: &mut Vec<ParsedItem>, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    match items.last_mut() {
        Some(ParsedItem::Data(existing)) => existing.extend(bytes),
        _ => items.push(ParsedItem::Data(bytes)),
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn partial_prefix_len(bytes: &[u8], prefix: &[u8]) -> usize {
    let max = bytes.len().min(prefix.len().saturating_sub(1));
    (1..=max)
        .rev()
        .find(|length| bytes.ends_with(&prefix[..*length]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{IntegrationEvent, ParsedItem, ShellIntegrationParser, MAX_MARKER_BYTES};
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    const NONCE: &str = "testnonce";

    fn marker(payload: &str) -> String {
        format!("\x1b]633;Termexa;{NONCE};{payload}\x07")
    }

    #[test]
    fn strips_markers_and_preserves_ordered_terminal_data() {
        let cwd = B64.encode("/opt/app");
        let input = format!(
            "before{}middle{}after",
            marker("H;bash"),
            marker(&format!("P;7;{cwd}"))
        );
        let mut parser = ShellIntegrationParser::new(NONCE);

        assert_eq!(
            parser.feed(input.as_bytes()),
            vec![
                ParsedItem::Data(b"before".to_vec()),
                ParsedItem::Event(IntegrationEvent::Ready {
                    shell: "bash".to_string()
                }),
                ParsedItem::Data(b"middle".to_vec()),
                ParsedItem::Event(IntegrationEvent::Prompt {
                    cwd: "/opt/app".to_string(),
                    exit_code: 7,
                    command: None,
                }),
                ParsedItem::Data(b"after".to_vec()),
            ]
        );
        assert!(parser.finish().is_empty());
    }

    #[test]
    fn handles_markers_split_across_network_chunks() {
        let mut parser = ShellIntegrationParser::new(NONCE);

        assert_eq!(
            parser.feed(b"hello\x1b]633;Termexa;test"),
            vec![ParsedItem::Data(b"hello".to_vec())]
        );
        assert_eq!(
            parser.feed(b"nonce;H;zsh\x07world"),
            vec![
                ParsedItem::Event(IntegrationEvent::Ready {
                    shell: "zsh".to_string()
                }),
                ParsedItem::Data(b"world".to_vec()),
            ]
        );
    }

    #[test]
    fn recognizes_the_private_bootstrap_acknowledgement() {
        let mut parser = ShellIntegrationParser::new(NONCE);
        assert_eq!(
            parser.feed(marker("B").as_bytes()),
            vec![ParsedItem::Event(IntegrationEvent::BootstrapReady)]
        );
    }

    #[test]
    fn decodes_the_completed_shell_command_from_a_prompt_marker() {
        let cwd = B64.encode("/root");
        let command = B64.encode("cat /etc/hosts");
        let input = marker(&format!("P;0;{cwd};{command}"));
        let mut parser = ShellIntegrationParser::new(NONCE);

        assert_eq!(
            parser.feed(input.as_bytes()),
            vec![ParsedItem::Event(IntegrationEvent::Prompt {
                cwd: "/root".to_string(),
                exit_code: 0,
                command: Some("cat /etc/hosts".to_string()),
            })]
        );
    }

    #[test]
    fn decodes_a_preexec_command_start_marker() {
        let command = B64.encode("cat /etc/hosts");
        let input = marker(&format!("C;{command}"));
        let mut parser = ShellIntegrationParser::new(NONCE);

        assert_eq!(
            parser.feed(input.as_bytes()),
            vec![ParsedItem::Event(IntegrationEvent::CommandStart {
                command: "cat /etc/hosts".to_string(),
            })]
        );
    }

    #[test]
    fn reports_unknown_shell_as_unavailable() {
        let mut parser = ShellIntegrationParser::new(NONCE);
        assert_eq!(
            parser.feed(marker("H;raw").as_bytes()),
            vec![ParsedItem::Event(IntegrationEvent::Unavailable)]
        );
    }

    #[test]
    fn treats_a_marker_with_the_wrong_nonce_as_terminal_data() {
        let input = b"\x1b]633;Termexa;wrongnonce;P;0;L3RtcA==\x07";
        let mut parser = ShellIntegrationParser::new(NONCE);

        assert_eq!(parser.feed(input), vec![ParsedItem::Data(input.to_vec())]);
    }

    #[test]
    fn flushes_an_oversized_incomplete_marker_instead_of_freezing_output() {
        let prefix = format!("\x1b]633;Termexa;{NONCE};");
        let input = format!("{prefix}{}tail", "x".repeat(MAX_MARKER_BYTES));
        let mut parser = ShellIntegrationParser::new(NONCE);

        let output = parser
            .feed(input.as_bytes())
            .into_iter()
            .flat_map(|item| match item {
                ParsedItem::Data(bytes) => bytes,
                ParsedItem::Event(_) => Vec::new(),
            })
            .collect::<Vec<_>>();
        assert_eq!(output, input.as_bytes());
        assert!(parser.finish().is_empty());
    }

    #[test]
    fn flushes_an_incomplete_marker_when_the_stream_ends() {
        let mut parser = ShellIntegrationParser::new(NONCE);
        assert!(parser.feed(b"output\x1b]633;Termexa;test").len() == 1);
        assert_eq!(parser.finish(), b"\x1b]633;Termexa;test".to_vec());
    }
}
