use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::util::shell_quote;

pub const DEFAULT_LEQI_ENDPOINT: &str =
    "http://tax-api-proxy-server.tax-digital.svc.cluster.local:8080/leqi/proxy/invoke";
pub const DEFAULT_LEQI_RUNNER_WORKLOAD: &str = "tax-api-proxy-server";
pub const DEFAULT_LEQI_TAX_PAYER_NO: &str = "91150100397352740W";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeqiApiInfo {
    pub api_identity: String,
    pub api_name: String,
    #[serde(default)]
    pub remarks: Option<String>,
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default)]
    pub url_suffix: Option<String>,
    #[serde(default)]
    pub use_case_code: Option<String>,
    #[serde(default)]
    pub server_code: Option<String>,
    #[serde(default)]
    pub ability_code: Option<String>,
    #[serde(default)]
    pub scene_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeqiInvokePayload {
    pub api_identity: String,
    pub tax_payer_no: String,
    pub test_mode: u8,
    #[serde(rename = "reqDTO")]
    pub req_dto: Map<String, Value>,
}

pub fn list_leqi_apis() -> Vec<LeqiApiInfo> {
    serde_json::from_str(include_str!("leqi_snapshot.json"))
        .expect("embedded Leqi snapshot must be valid")
}

pub fn parse_req_dto_json(value: &str) -> Result<Map<String, Value>> {
    let parsed: Value = serde_json::from_str(value)?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(anyhow!("reqDTO 必须是 JSON object")),
    }
}

pub fn build_leqi_invoke_payload(
    api: &LeqiApiInfo,
    tax_payer_no: &str,
    test_mode: u8,
    req_dto: Map<String, Value>,
) -> LeqiInvokePayload {
    LeqiInvokePayload {
        api_identity: api.api_identity.clone(),
        tax_payer_no: tax_payer_no.to_string(),
        test_mode,
        req_dto,
    }
}

pub fn build_leqi_curl(endpoint: &str, payload: &LeqiInvokePayload) -> Result<String> {
    let payload = serde_json::to_string(payload)?;
    Ok([
        format!("curl {} \\", shell_quote(endpoint)),
        format!("  -H {} \\", shell_quote("Content-Type: application/json")),
        format!("  --data-raw {}", shell_quote(&payload)),
    ]
    .join("\n"))
}

pub fn build_leqi_exec_curl_command(
    endpoint: &str,
    payload: &LeqiInvokePayload,
) -> Result<Vec<String>> {
    let payload = serde_json::to_string(payload)?;
    Ok(vec![
        "sh".to_string(),
        "-lc".to_string(),
        [
            "curl -sS".to_string(),
            shell_quote(endpoint),
            "-H".to_string(),
            shell_quote("Content-Type: application/json"),
            "--data-raw".to_string(),
            shell_quote(&payload),
        ]
        .join(" "),
    ])
}

pub fn format_leqi_api_choice(api: &LeqiApiInfo) -> String {
    let remark = api
        .remarks
        .as_ref()
        .filter(|remark| *remark != &api.api_name)
        .map(|remark| format!("  {remark}"))
        .unwrap_or_default();
    let module = api
        .module
        .as_ref()
        .map(|module| format!("  {module}"))
        .unwrap_or_default();
    format!("{}  {}{}{}", api.api_identity, api.api_name, module, remark)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_embedded_snapshot() {
        let apis = list_leqi_apis();
        assert_eq!(apis.len(), 131);
        let api = apis
            .iter()
            .find(|api| api.api_identity == "200000001")
            .unwrap();
        assert_eq!(api.api_name, "下载退回授信额度");
    }

    #[test]
    fn builds_payload_and_curl() {
        let api = list_leqi_apis()
            .into_iter()
            .find(|api| api.api_identity == "200000001")
            .unwrap();
        let req_dto = parse_req_dto_json(r#"{"sqed":20000000}"#).unwrap();
        let payload = build_leqi_invoke_payload(&api, "91150100397352740W", 0, req_dto);
        let curl = build_leqi_curl("http://proxy/leqi/proxy/invoke", &payload).unwrap();
        assert!(curl.contains("--data-raw '{\"apiIdentity\":\"200000001\""));
        assert_eq!(format_leqi_api_choice(&api), "200000001  下载退回授信额度");
    }

    #[test]
    fn rejects_non_object_req_dto() {
        assert!(parse_req_dto_json("[]").is_err());
    }
}
