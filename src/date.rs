use anyhow::{anyhow, Result};
use chrono::{Datelike, Duration, Local, NaiveDate};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateSelection {
    pub from: String,
    pub to: String,
    pub dates: Vec<String>,
}

pub fn assert_date_string(value: &str) -> Result<String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| anyhow!("日期格式必须是 YYYY-MM-DD：{value}"))?;
    let normalized = date.format("%Y-%m-%d").to_string();
    if normalized != value {
        return Err(anyhow!("无效日期：{value}"));
    }
    Ok(normalized)
}

pub fn build_date_selection(
    date: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    recent_days: Option<i64>,
) -> Result<DateSelection> {
    if let Some(date) = date {
        let date = assert_date_string(date)?;
        return Ok(DateSelection {
            from: date.clone(),
            to: date.clone(),
            dates: vec![date],
        });
    }

    if from.is_some() || to.is_some() {
        let from = from.ok_or_else(|| anyhow!("--from 和 --to 需要同时提供"))?;
        let to = to.ok_or_else(|| anyhow!("--from 和 --to 需要同时提供"))?;
        return build_date_range(&assert_date_string(from)?, &assert_date_string(to)?);
    }

    if let Some(days) = recent_days {
        if days <= 0 {
            return Err(anyhow!("--recent-days 需要正整数"));
        }
        let today = Local::now().date_naive();
        let from = today - Duration::days(days - 1);
        return build_date_range(
            &from.format("%Y-%m-%d").to_string(),
            &today.format("%Y-%m-%d").to_string(),
        );
    }

    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    Ok(DateSelection {
        from: today.clone(),
        to: today.clone(),
        dates: vec![today],
    })
}

pub fn build_date_range(from: &str, to: &str) -> Result<DateSelection> {
    let start = NaiveDate::parse_from_str(from, "%Y-%m-%d")?;
    let end = NaiveDate::parse_from_str(to, "%Y-%m-%d")?;
    if start > end {
        return Err(anyhow!("起始日期不能晚于结束日期：{from} > {to}"));
    }
    let mut dates = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        dates.push(cursor.format("%Y-%m-%d").to_string());
        cursor += Duration::days(1);
    }
    Ok(DateSelection {
        from: from.to_string(),
        to: to.to_string(),
        dates,
    })
}

pub fn build_content_date_regex(dates: &[String]) -> String {
    dates
        .iter()
        .map(|date| {
            let mut parts = date.split('-');
            let year = parts.next().unwrap_or_default();
            let month = parts.next().unwrap_or_default();
            let day = parts.next().unwrap_or_default();
            format!("{year}[-/.]{month}[-/.]{day}")
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn today_text() -> String {
    let today = Local::now();
    format!(
        "{:04}-{:02}-{:02}",
        today.year(),
        today.month(),
        today.day()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_date_ranges() {
        let selection = build_date_range("2026-06-24", "2026-06-26").unwrap();
        assert_eq!(
            selection.dates,
            vec!["2026-06-24", "2026-06-25", "2026-06-26"]
        );
        assert_eq!(
            build_content_date_regex(&["2026-06-24".to_string()]),
            "2026[-/.]06[-/.]24"
        );
    }
}
