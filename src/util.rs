use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Datelike, Local, Timelike};
use std::collections::BTreeMap;
use std::path::PathBuf;
use url::Url;

pub type CookieJar = BTreeMap<String, String>;

pub fn normalize_base_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("KubeSphere 地址不能为空"));
    }

    let with_protocol = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&with_protocol).context("KubeSphere 地址无效")?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(anyhow!("KubeSphere 地址只支持 http 或 https"));
    }

    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    let normalized = url.to_string().trim_end_matches('/').to_string();
    Ok(normalized)
}

pub fn join_url(base: &str, api_path: &str) -> String {
    let normalized = if api_path.starts_with('/') {
        api_path.to_string()
    } else {
        format!("/{api_path}")
    };
    format!("{base}{normalized}")
}

pub fn encrypt_password(encrypt_key: &str, password: &str) -> String {
    let mut key = if encrypt_key.is_empty() {
        "kubesphere".to_string()
    } else {
        encrypt_key.to_string()
    };
    let encoded_password = STANDARD.encode(password.as_bytes());

    if encoded_password.len() > key.len() {
        key.push_str(&encoded_password[..encoded_password.len() - key.len()]);
    }

    let password_bytes = encoded_password.as_bytes();
    let mut odd_even_bits = String::new();
    let mut mixed_chars = String::new();

    for (index, key_byte) in key.as_bytes().iter().enumerate() {
        let password_char_code = password_bytes.get(index).copied().unwrap_or(64);
        let combined = *key_byte as u16 + password_char_code as u16;
        odd_even_bits.push(if combined % 2 == 0 { '0' } else { '1' });
        mixed_chars.push(char::from_u32((combined / 2) as u32).unwrap_or('@'));
    }

    format!(
        "{}@{}",
        STANDARD.encode(odd_even_bits.as_bytes()),
        mixed_chars
    )
}

pub fn parse_set_cookie_headers(headers: &[String]) -> CookieJar {
    let mut jar = CookieJar::new();
    for header in headers {
        let first_part = header.split(';').next().unwrap_or_default();
        if let Some((name, value)) = first_part.split_once('=') {
            let name = name.trim();
            if !name.is_empty() {
                jar.insert(name.to_string(), value.trim().to_string());
            }
        }
    }
    jar
}

pub fn merge_cookie_jar(target: &mut CookieJar, source: CookieJar) {
    for (name, value) in source {
        target.insert(name, value);
    }
}

pub fn cookie_header_from_jar(jar: &CookieJar) -> String {
    jar.iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn selector_to_string(selector: &BTreeMap<String, String>) -> String {
    selector
        .iter()
        .filter(|(key, value)| !key.is_empty() && !value.is_empty())
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",")
}

pub fn sanitize_file_name(value: &str) -> String {
    let mut sanitized = String::new();
    let mut last_was_underscore = false;

    for ch in value.chars() {
        let invalid = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control()
            || ch.is_whitespace();
        let out = if invalid { '_' } else { ch };
        if out == '_' {
            if !last_was_underscore {
                sanitized.push(out);
            }
            last_was_underscore = true;
        } else {
            sanitized.push(out);
            last_was_underscore = false;
        }
    }

    let trimmed = sanitized.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "log".to_string()
    } else {
        trimmed
    }
}

pub fn timestamp_for_file_now() -> String {
    let now = Local::now();
    format!(
        "{:04}{:02}{:02}_{:02}{:02}{:02}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

pub fn default_output_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Downloads")
        .join("workctl")
        .join("kubesphere-logs")
}

pub fn build_log_file_name(namespace: &str, service: &str, pod: &str) -> String {
    format!(
        "{}_{}_{}_{}.log",
        sanitize_file_name(namespace),
        sanitize_file_name(service),
        sanitize_file_name(pod),
        timestamp_for_file_now()
    )
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KiB", bytes as f64 / 1024.0);
    }
    format!("{:.1} MiB", bytes as f64 / 1024.0 / 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_kubesphere_password() {
        assert_eq!(
            encrypt_password("kubesphere", "P@88w0rd"),
            "MDAxMTAwMTAxMDAw@`]QLa\\enjiSA"
        );
    }

    #[test]
    fn normalizes_urls_and_cookies() {
        assert_eq!(
            normalize_base_url("192.168.7.191:30880/").unwrap(),
            "http://192.168.7.191:30880"
        );
        let jar = parse_set_cookie_headers(&[
            "token=abc.def; path=/; httponly".to_string(),
            "refreshToken=xyz; path=/; httponly".to_string(),
        ]);
        assert_eq!(
            cookie_header_from_jar(&jar),
            "refreshToken=xyz; token=abc.def"
        );
    }

    #[test]
    fn file_helpers_are_stable() {
        assert_eq!(
            sanitize_file_name("tax/digital:server*"),
            "tax_digital_server"
        );
        assert_eq!(
            shell_quote("/opt/saas-logs/a'b.log"),
            "'/opt/saas-logs/a'\\''b.log'"
        );
    }
}
