use anyhow::{anyhow, Context, Result};
use std::io::Write;
use std::path::Path;

use crate::date::DateSelection;
use crate::kube::{ExecOptions, KubeSphereClient};
use crate::util::shell_quote;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryLogFile {
    pub path: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct HistoryTarget {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub history_path: String,
}

#[derive(Debug, Clone)]
pub struct HistoryExportOptions {
    pub target: HistoryTarget,
    pub files: Vec<HistoryLogFile>,
    pub date_selection: DateSelection,
    pub output_path: std::path::PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryExportProgress {
    pub file_index: usize,
    pub file_count: usize,
    pub current_file: Option<String>,
    pub source_bytes_processed: u64,
    pub total_source_bytes: Option<u64>,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryExportResult {
    pub matched_files: usize,
    pub skipped_files: usize,
    pub scanned_files: usize,
    pub bytes_written: u64,
}

pub async fn list_history_files(
    client: &mut KubeSphereClient,
    target: &HistoryTarget,
) -> Result<Vec<HistoryLogFile>> {
    let command = build_list_files_command(&target.history_path);
    let result = client
        .exec_command(ExecOptions {
            namespace: target.namespace.clone(),
            pod: target.pod.clone(),
            container: target.container.clone(),
            command: vec!["sh".to_string(), "-lc".to_string(), command],
            timeout_ms: 60_000,
        })
        .await?;

    if !result.stderr.trim().is_empty() && result.stdout.trim().is_empty() {
        return Err(anyhow!("列历史日志失败：{}", result.stderr.trim()));
    }

    Ok(result
        .stdout
        .lines()
        .filter_map(parse_history_file_line)
        .collect())
}

pub async fn stat_history_files(
    client: &mut KubeSphereClient,
    target: &HistoryTarget,
    files: &[String],
) -> Result<Vec<HistoryLogFile>> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let result = client
        .exec_command(ExecOptions {
            namespace: target.namespace.clone(),
            pod: target.pod.clone(),
            container: target.container.clone(),
            command: vec![
                "sh".to_string(),
                "-lc".to_string(),
                build_stat_files_command(files),
            ],
            timeout_ms: 60_000,
        })
        .await?;

    if !result.stderr.trim().is_empty() && result.stdout.trim().is_empty() {
        return Err(anyhow!("读取历史日志大小失败：{}", result.stderr.trim()));
    }

    let mut found = result
        .stdout
        .lines()
        .filter_map(parse_history_file_line)
        .collect::<Vec<_>>();
    let found_paths = found
        .iter()
        .map(|file| file.path.clone())
        .collect::<std::collections::HashSet<_>>();
    for file in files {
        if !found_paths.contains(file) {
            found.push(HistoryLogFile {
                path: file.clone(),
                size: None,
            });
        }
    }
    Ok(found)
}

pub fn filter_history_files_by_service(
    files: &[HistoryLogFile],
    service_name: &str,
) -> Vec<HistoryLogFile> {
    let service_name = service_name.to_lowercase();
    files
        .iter()
        .filter(|file| file.path.to_lowercase().contains(&service_name))
        .cloned()
        .collect()
}

pub async fn export_history_logs<F>(
    client: &mut KubeSphereClient,
    options: HistoryExportOptions,
    mut on_progress: F,
) -> Result<HistoryExportResult>
where
    F: FnMut(HistoryExportProgress) + Send,
{
    if let Some(parent) = options.output_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let pattern = crate::date::build_content_date_regex(&options.date_selection.dates);
    let mut output = std::io::BufWriter::new(
        std::fs::File::create(&options.output_path)
            .with_context(|| format!("创建输出文件失败：{}", options.output_path.display()))?,
    );
    let total_source_bytes = total_known_size(&options.files);
    let file_count = options.files.len();
    let mut result = HistoryExportResult {
        scanned_files: file_count,
        ..HistoryExportResult::default()
    };
    let mut source_bytes_processed = 0u64;

    for (index, file) in options.files.iter().enumerate() {
        on_progress(HistoryExportProgress {
            file_index: index + 1,
            file_count,
            current_file: Some(file.path.clone()),
            source_bytes_processed,
            total_source_bytes,
            bytes_written: result.bytes_written,
        });

        let mut wrote_header = false;
        let mut saw_unsupported_gzip = false;
        let mut write_error: Option<String> = None;
        let command = build_grep_command(&file.path, &pattern);
        let target = &options.target;

        client
            .stream_exec_output(
                ExecOptions {
                    namespace: target.namespace.clone(),
                    pod: target.pod.clone(),
                    container: target.container.clone(),
                    command: vec!["sh".to_string(), "-lc".to_string(), command],
                    timeout_ms: 10 * 60 * 1000,
                },
                |chunk| {
                    if write_error.is_some() {
                        return;
                    }
                    if !wrote_header {
                        let header = format!("===== {} =====\n", file.path);
                        if let Err(error) = output.write_all(header.as_bytes()) {
                            write_error = Some(error.to_string());
                            return;
                        }
                        result.bytes_written += header.len() as u64;
                        wrote_header = true;
                    }
                    if let Err(error) = output.write_all(chunk) {
                        write_error = Some(error.to_string());
                        return;
                    }
                    result.bytes_written += chunk.len() as u64;
                    on_progress(HistoryExportProgress {
                        file_index: index + 1,
                        file_count,
                        current_file: Some(file.path.clone()),
                        source_bytes_processed,
                        total_source_bytes,
                        bytes_written: result.bytes_written,
                    });
                },
                |chunk| {
                    if String::from_utf8_lossy(chunk).contains("__WORKCTL_SKIP_GZIP__") {
                        saw_unsupported_gzip = true;
                    }
                },
                |_| {},
            )
            .await?;

        if let Some(error) = write_error {
            return Err(anyhow!("写入历史日志失败：{error}"));
        }

        if wrote_header {
            output.write_all(b"\n")?;
            result.bytes_written += 1;
            result.matched_files += 1;
        } else if saw_unsupported_gzip {
            result.skipped_files += 1;
        }

        source_bytes_processed += file.size.unwrap_or(0);
        on_progress(HistoryExportProgress {
            file_index: index + 1,
            file_count,
            current_file: Some(file.path.clone()),
            source_bytes_processed,
            total_source_bytes,
            bytes_written: result.bytes_written,
        });
    }

    output.flush()?;
    Ok(result)
}

pub fn parse_history_file_line(line: &str) -> Option<HistoryLogFile> {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let Some((size_text, path)) = trimmed.split_once('\t') else {
        return Some(HistoryLogFile {
            path: trimmed.trim().to_string(),
            size: None,
        });
    };
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    Some(HistoryLogFile {
        path: path.to_string(),
        size: size_text.trim().parse::<u64>().ok(),
    })
}

pub fn total_known_size(files: &[HistoryLogFile]) -> Option<u64> {
    let mut total = 0u64;
    for file in files {
        total += file.size?;
    }
    Some(total)
}

pub fn build_list_files_command(history_path: &str) -> String {
    [
        format!("base={}", shell_quote(history_path)),
        r#"if find "$base" -maxdepth 0 -printf '' >/dev/null 2>&1; then"#.to_string(),
        r#"  find "$base" -type f -printf '%s\t%p\n' 2>/dev/null | sort -k2"#.to_string(),
        "else".to_string(),
        r#"  find "$base" -type f 2>/dev/null | sort | while IFS= read -r file; do"#.to_string(),
        r#"    size=$(stat -c %s "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || true)"#
            .to_string(),
        r#"    printf '%s\t%s\n' "$size" "$file""#.to_string(),
        "  done".to_string(),
        "fi".to_string(),
    ]
    .join("\n")
}

pub fn build_stat_files_command(files: &[String]) -> String {
    [
        format!(
            "for file in {}; do",
            files
                .iter()
                .map(|file| shell_quote(file))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        r#"  if [ -f "$file" ]; then"#.to_string(),
        r#"    size=$(stat -c %s "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || true)"#
            .to_string(),
        r#"    printf '%s\t%s\n' "$size" "$file""#.to_string(),
        "  else".to_string(),
        r#"    printf '\t%s\n' "$file""#.to_string(),
        "  fi".to_string(),
        "done".to_string(),
    ]
    .join("\n")
}

pub fn build_grep_command(file: &str, pattern: &str) -> String {
    [
        format!("file={}", shell_quote(file)),
        format!("pattern={}", shell_quote(pattern)),
        r#"case "$file" in"#.to_string(),
        "  *.gz)".to_string(),
        "    if command -v zgrep >/dev/null 2>&1; then".to_string(),
        r#"      zgrep -h -E -- "$pattern" "$file" || true"#.to_string(),
        "    else".to_string(),
        r#"      echo "__WORKCTL_SKIP_GZIP__: zgrep not found for $file" >&2"#.to_string(),
        "    fi".to_string(),
        "    ;;".to_string(),
        "  *)".to_string(),
        r#"    grep -h -E -- "$pattern" "$file" || true"#.to_string(),
        "    ;;".to_string(),
        "esac".to_string(),
    ]
    .join("\n")
}

pub fn output_path_exists(path: &Path) -> bool {
    path.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_history_file_lines() {
        assert_eq!(
            parse_history_file_line("123\t/opt/saas-logs/a.log"),
            Some(HistoryLogFile {
                path: "/opt/saas-logs/a.log".to_string(),
                size: Some(123),
            })
        );
        assert_eq!(
            parse_history_file_line("/opt/saas-logs/a.log"),
            Some(HistoryLogFile {
                path: "/opt/saas-logs/a.log".to_string(),
                size: None,
            })
        );
        assert_eq!(parse_history_file_line(""), None);
    }

    #[test]
    fn filters_and_totals_history_files() {
        let files = vec![
            HistoryLogFile {
                path: "/opt/saas-logs/tax-a.log".to_string(),
                size: Some(10),
            },
            HistoryLogFile {
                path: "/opt/saas-logs/other.log".to_string(),
                size: Some(20),
            },
        ];
        assert_eq!(filter_history_files_by_service(&files, "tax").len(), 1);
        assert_eq!(total_known_size(&files), Some(30));
    }

    #[test]
    fn builds_safe_grep_command() {
        let command = build_grep_command("/opt/saas-logs/a'b.log.gz", "2026-06-24");
        assert!(command.contains("'/opt/saas-logs/a'\\''b.log.gz'"));
        assert!(command.contains("__WORKCTL_SKIP_GZIP__"));
    }
}
