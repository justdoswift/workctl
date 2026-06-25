use anyhow::{anyhow, Context, Result};
use chrono::{Duration as ChronoDuration, Local};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Gauge, List, ListItem, ListState, Paragraph, Wrap},
    Terminal,
};
use std::{
    io::{self, Stdout},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    date::{build_date_range, build_date_selection, today_text, DateSelection},
    history::{
        export_history_logs, filter_history_files_by_service, list_history_files,
        HistoryExportOptions, HistoryExportProgress, HistoryLogFile, HistoryTarget,
    },
    kube::{ClientOptions, KubeSphereClient, KubeTarget, LogRange, PodSummary},
    leqi::{
        build_leqi_curl, build_leqi_exec_curl_command, build_leqi_invoke_payload,
        format_leqi_api_choice, list_leqi_apis, parse_req_dto_json, LeqiApiInfo,
        DEFAULT_LEQI_ENDPOINT, DEFAULT_LEQI_RUNNER_WORKLOAD, DEFAULT_LEQI_TAX_PAYER_NO,
    },
    profile::{
        choose_default_profile, read_profiles, remove_profile, set_default_profile, upsert_profile,
        SavedProfile, UpsertProfile,
    },
    util::{
        build_log_file_name, default_output_dir, format_bytes, sanitize_file_name,
        timestamp_for_file_now,
    },
};

type Tui = Terminal<CrosstermBackend<Stdout>>;

pub async fn run() -> Result<()> {
    let mut terminal = init_terminal()?;
    let result = run_app(&mut terminal).await;
    restore_terminal(&mut terminal)?;
    result
}

async fn run_app(terminal: &mut Tui) -> Result<()> {
    loop {
        let items = vec![
            "K8s 日志".to_string(),
            "乐企接口".to_string(),
            "环境配置".to_string(),
            "退出".to_string(),
        ];
        let Some(choice) = select_list(terminal, "workctl", "选择一个功能", &items, 0)?
        else {
            return Ok(());
        };
        match choice {
            0 => run_k8s_logs(terminal).await?,
            1 => run_leqi(terminal).await?,
            2 => manage_profiles(terminal).await?,
            _ => return Ok(()),
        }
    }
}

async fn run_k8s_logs(terminal: &mut Tui) -> Result<()> {
    let profile = select_or_create_profile(terminal, "K8s 日志").await?;
    let mut client = login_with_profile(terminal, &profile).await?;

    draw_message(terminal, "K8s 日志", "正在加载 namespace...")?;
    let namespaces = client.list_namespaces().await?;
    if namespaces.is_empty() {
        wait_message(terminal, "K8s 日志", "当前账号没有可见 namespace")?;
        return Ok(());
    }
    let initial_namespace = namespaces
        .iter()
        .position(|name| name == "tax-digital")
        .unwrap_or(0);
    let Some(namespace_index) = select_list(
        terminal,
        "K8s 日志",
        "选择 namespace",
        &namespaces,
        initial_namespace,
    )?
    else {
        return Ok(());
    };
    let namespace = namespaces[namespace_index].clone();

    draw_message(terminal, "K8s 日志", "正在加载工作负载...")?;
    let targets = client.list_targets(&namespace).await?;
    if targets.is_empty() {
        wait_message(
            terminal,
            "K8s 日志",
            "这个 namespace 下没有 Deployment 工作负载",
        )?;
        return Ok(());
    }
    let target_items = targets.iter().map(format_target_choice).collect::<Vec<_>>();
    let Some(target_index) = select_list(terminal, "K8s 日志", "选择工作负载", &target_items, 0)?
    else {
        return Ok(());
    };
    let target = targets[target_index].clone();

    draw_message(terminal, "K8s 日志", "正在加载 Pod...")?;
    let pods = client.list_pods_for_target(&target).await?;
    if pods.is_empty() {
        wait_message(
            terminal,
            "K8s 日志",
            &format!(
                "工作负载 {} 当前没有匹配的 Pod（{}/{}）",
                target.name, target.ready_replicas, target.desired_replicas
            ),
        )?;
        return Ok(());
    }
    let pod_items = pods.iter().map(format_pod_choice).collect::<Vec<_>>();
    let Some(pod_index) = select_list(terminal, "K8s 日志", "选择 Pod", &pod_items, 0)? else {
        return Ok(());
    };
    let pod = pods[pod_index].clone();

    if pod.containers.is_empty() {
        wait_message(terminal, "K8s 日志", "这个 Pod 没有可选容器")?;
        return Ok(());
    }
    let Some(container_index) = select_list(terminal, "K8s 日志", "选择容器", &pod.containers, 0)?
    else {
        return Ok(());
    };
    let container = pod.containers[container_index].clone();

    let source_items = vec![
        "当前容器日志".to_string(),
        "历史文件日志 /opt/saas-logs".to_string(),
    ];
    let Some(source_index) = select_list(terminal, "K8s 日志", "选择日志来源", &source_items, 0)?
    else {
        return Ok(());
    };

    if source_index == 0 {
        run_current_log_flow(terminal, client, namespace, target, pod, container).await?;
    } else {
        run_history_log_flow(terminal, client, namespace, target, pod, container).await?;
    }

    Ok(())
}

async fn run_current_log_flow(
    terminal: &mut Tui,
    client: KubeSphereClient,
    namespace: String,
    target: KubeTarget,
    pod: PodSummary,
    container: String,
) -> Result<()> {
    let range = choose_current_range(terminal)?;
    let output_path =
        default_output_dir().join(build_log_file_name(&namespace, &target.name, &pod.name));
    let summary = vec![
        format!("namespace: {namespace}"),
        format!(
            "工作负载: {} ({}/{})",
            target.name, target.ready_replicas, target.desired_replicas
        ),
        format!("Pod: {}", pod.name),
        format!("容器: {container}"),
        format!("范围: {}", format_log_range(&range)),
        format!("保存到: {}", output_path.display()),
    ];
    if !confirm_lines(terminal, "确认下载当前日志", &summary, true)? {
        return Ok(());
    }
    run_current_download_progress(
        terminal,
        client,
        namespace,
        pod.name,
        container,
        range,
        output_path,
    )
    .await
}

async fn run_history_log_flow(
    terminal: &mut Tui,
    mut client: KubeSphereClient,
    namespace: String,
    target: KubeTarget,
    pod: PodSummary,
    container: String,
) -> Result<()> {
    let history_path = input_text(
        terminal,
        "历史日志",
        "历史日志路径",
        "/opt/saas-logs",
        false,
    )?;
    let history_target = HistoryTarget {
        namespace: namespace.clone(),
        pod: pod.name.clone(),
        container: container.clone(),
        history_path,
    };
    draw_message(terminal, "历史日志", "正在列出 /opt/saas-logs 文件...")?;
    let all_files = list_history_files(&mut client, &history_target).await?;
    if all_files.is_empty() {
        wait_message(terminal, "历史日志", "没有找到历史日志文件")?;
        return Ok(());
    }
    let preferred = filter_history_files_by_service(&all_files, &target.name);
    let files = if preferred.is_empty() {
        all_files
    } else {
        preferred
    };
    let selected_files = choose_history_files(terminal, &files)?;
    if selected_files.is_empty() {
        return Ok(());
    }
    let date_selection = choose_date_selection(terminal)?;
    let output_path = default_output_dir().join(build_history_log_file_name(
        &namespace,
        &target.name,
        &pod.name,
        &date_selection,
    ));
    let summary = vec![
        format!("namespace: {namespace}"),
        format!(
            "工作负载: {} ({}/{})",
            target.name, target.ready_replicas, target.desired_replicas
        ),
        format!("Pod: {}", pod.name),
        format!("容器: {container}"),
        format!("日期: {} 到 {}", date_selection.from, date_selection.to),
        format!("文件数: {}", selected_files.len()),
        format!("保存到: {}", output_path.display()),
    ];
    if !confirm_lines(terminal, "确认导出历史日志", &summary, true)? {
        return Ok(());
    }

    run_history_download_progress(
        terminal,
        client,
        HistoryExportOptions {
            target: history_target,
            files: selected_files,
            date_selection,
            output_path,
        },
    )
    .await
}

async fn run_leqi(terminal: &mut Tui) -> Result<()> {
    let api = choose_leqi_api(terminal)?;
    let tax_payer_no = input_text(
        terminal,
        "乐企接口",
        "taxPayerNo",
        DEFAULT_LEQI_TAX_PAYER_NO,
        false,
    )?;
    let test_mode_text = input_text(terminal, "乐企接口", "testMode", "0", false)?;
    let test_mode = test_mode_text
        .trim()
        .parse::<u8>()
        .map_err(|_| anyhow!("testMode 必须是 0-255 的数字"))?;
    let req_dto_text = input_text(
        terminal,
        "乐企接口",
        "reqDTO JSON",
        r#"{"ptbh":"1fc4107f168694d1efb5","nsrsbh":"91150100397352740W","sqlx":"1","sqed":20000000}"#,
        false,
    )?;
    let req_dto = parse_req_dto_json(&req_dto_text)?;
    let payload = build_leqi_invoke_payload(&api, &tax_payer_no, test_mode, req_dto);
    let actions = vec!["导出 curl".to_string(), "直接调用".to_string()];
    let Some(action) = select_list(terminal, "乐企接口", "选择操作", &actions, 0)? else {
        return Ok(());
    };

    if action == 0 {
        let curl = build_leqi_curl(DEFAULT_LEQI_ENDPOINT, &payload)?;
        show_text(terminal, "乐企 curl", &curl)?;
        return Ok(());
    }

    let summary = vec![
        format!("接口: {} {}", api.api_identity, api.api_name),
        format!("taxPayerNo: {tax_payer_no}"),
        format!("testMode: {test_mode}"),
        format!("endpoint: {DEFAULT_LEQI_ENDPOINT}"),
    ];
    if !confirm_lines(terminal, "确认直接调用乐企接口", &summary, false)? {
        return Ok(());
    }

    let profile = select_or_create_profile(terminal, "乐企接口调用").await?;
    let mut client = login_with_profile(terminal, &profile).await?;
    let namespace = "tax-digital".to_string();
    draw_message(terminal, "乐企接口", "正在查找可执行 curl 的工作负载...")?;
    let mut targets = client.list_targets(&namespace).await?;
    if targets.is_empty() {
        wait_message(
            terminal,
            "乐企接口",
            "tax-digital 下没有 Deployment 工作负载",
        )?;
        return Ok(());
    }
    targets.sort_by_key(|target| {
        if target.name == DEFAULT_LEQI_RUNNER_WORKLOAD {
            0
        } else {
            1
        }
    });
    let target_items = targets.iter().map(format_target_choice).collect::<Vec<_>>();
    let Some(target_index) = select_list(
        terminal,
        "乐企接口",
        "选择执行 curl 的工作负载",
        &target_items,
        0,
    )?
    else {
        return Ok(());
    };
    let target = targets[target_index].clone();
    let pods = client.list_pods_for_target(&target).await?;
    if pods.is_empty() {
        wait_message(terminal, "乐企接口", "执行工作负载当前没有 Pod")?;
        return Ok(());
    }
    let pod_items = pods.iter().map(format_pod_choice).collect::<Vec<_>>();
    let Some(pod_index) = select_list(terminal, "乐企接口", "选择执行 curl 的 Pod", &pod_items, 0)?
    else {
        return Ok(());
    };
    let pod = pods[pod_index].clone();
    if pod.containers.is_empty() {
        wait_message(terminal, "乐企接口", "这个 Pod 没有可选容器")?;
        return Ok(());
    }
    let Some(container_index) = select_list(
        terminal,
        "乐企接口",
        "选择执行 curl 的容器",
        &pod.containers,
        0,
    )?
    else {
        return Ok(());
    };
    let command = build_leqi_exec_curl_command(DEFAULT_LEQI_ENDPOINT, &payload)?;
    draw_message(terminal, "乐企接口", "正在集群内执行 curl...")?;
    let result = client
        .exec_command(crate::kube::ExecOptions {
            namespace,
            pod: pod.name,
            container: pod.containers[container_index].clone(),
            command,
            timeout_ms: 120_000,
        })
        .await?;
    let mut text = String::new();
    if !result.stdout.trim().is_empty() {
        text.push_str("STDOUT\n");
        text.push_str(&result.stdout);
    }
    if !result.stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str("STDERR\n");
        text.push_str(&result.stderr);
    }
    if !result.error.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str("ERROR\n");
        text.push_str(&result.error);
    }
    if text.trim().is_empty() {
        text = "调用完成，但没有输出。".to_string();
    }
    show_text(terminal, "乐企调用结果", &text)
}

async fn manage_profiles(terminal: &mut Tui) -> Result<()> {
    let mut selected = 0usize;
    loop {
        let config = read_profiles()?;
        let items = if config.profiles.is_empty() {
            vec!["还没有保存环境，按 a 新增".to_string()]
        } else {
            config
                .profiles
                .iter()
                .map(|profile| {
                    let marker = if config.default_profile.as_deref() == Some(profile.name.as_str())
                    {
                        "*"
                    } else {
                        " "
                    };
                    format!(
                        "{marker} {}  {}  {}",
                        profile.name, profile.url, profile.username
                    )
                })
                .collect()
        };
        if selected >= items.len() {
            selected = items.len().saturating_sub(1);
        }

        terminal.draw(|frame| {
            let area = frame.area();
            let block = Block::default()
                .title("环境配置")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray));
            let list_items = items
                .iter()
                .map(|item| ListItem::new(item.as_str()))
                .collect::<Vec<_>>();
            let mut state = ListState::default();
            state.select(Some(selected));
            let list = List::new(list_items)
                .block(block)
                .highlight_symbol("› ")
                .highlight_style(
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                );
            frame.render_stateful_widget(list, area, &mut state);
            render_footer(frame, "↑/↓ 选择  a 新增  d 删除  u 设默认  Esc 返回");
        })?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(()),
            KeyCode::Up => selected = selected.saturating_sub(1),
            KeyCode::Down => selected = (selected + 1).min(items.len().saturating_sub(1)),
            KeyCode::Char('a') => {
                if let Err(error) = create_profile_interactively(terminal, true).await {
                    wait_message(terminal, "环境配置", &format!("新增环境失败：{error}"))?;
                }
            }
            KeyCode::Char('d') => {
                if let Some(profile) = config.profiles.get(selected) {
                    if confirm_lines(
                        terminal,
                        "删除环境",
                        &[format!("删除环境：{}", profile.name)],
                        false,
                    )? {
                        remove_profile(&profile.name)?;
                    }
                }
            }
            KeyCode::Char('u') => {
                if let Some(profile) = config.profiles.get(selected) {
                    set_default_profile(&profile.name)?;
                }
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(()),
            _ => {}
        }
    }
}

async fn select_or_create_profile(terminal: &mut Tui, title: &str) -> Result<SavedProfile> {
    loop {
        let config = read_profiles()?;
        let mut items = config
            .profiles
            .iter()
            .map(|profile| {
                let marker = if config.default_profile.as_deref() == Some(profile.name.as_str()) {
                    " (默认)"
                } else {
                    ""
                };
                format!("{}{}  {}", profile.name, marker, profile.url)
            })
            .collect::<Vec<_>>();
        items.push("新增环境".to_string());
        let initial = choose_default_profile(&config)
            .and_then(|profile| {
                config
                    .profiles
                    .iter()
                    .position(|item| item.name == profile.name)
            })
            .unwrap_or(0);
        let Some(index) = select_list(terminal, title, "选择 KubeSphere 环境", &items, initial)?
        else {
            return Err(anyhow!("已取消"));
        };
        if index < config.profiles.len() {
            return Ok(config.profiles[index].clone());
        }
        match create_profile_interactively(terminal, true).await {
            Ok(profile) => return Ok(profile),
            Err(error) => wait_message(terminal, title, &format!("新增环境失败：{error}"))?,
        }
    }
}

async fn create_profile_interactively(
    terminal: &mut Tui,
    set_default: bool,
) -> Result<SavedProfile> {
    let config = read_profiles()?;
    let name = input_text(terminal, "新增环境", "环境名称", "", false)?;
    if config.profiles.iter().any(|profile| profile.name == name) {
        return Err(anyhow!("环境名称已存在，请换一个名称"));
    }
    let url = input_text(
        terminal,
        "新增环境",
        "KubeSphere 地址",
        "http://192.168.7.191:30880",
        false,
    )?;
    let username = input_text(terminal, "新增环境", "用户名", "admin", false)?;
    let password = input_text(
        terminal,
        "新增环境",
        "密码（会明文保存到 ~/.workctl/profiles.json）",
        "",
        true,
    )?;
    let insecure = confirm_lines(
        terminal,
        "新增环境",
        &["是否允许 https 自签名证书？".to_string()],
        false,
    )?;

    draw_message(terminal, "新增环境", "正在验证登录，成功后保存环境...")?;
    let mut client = KubeSphereClient::new(ClientOptions {
        base_url: url.clone(),
        insecure,
    })?;
    client.login(&username, &password).await?;

    upsert_profile(UpsertProfile {
        name,
        url,
        username,
        password,
        insecure,
        set_default,
    })
}

async fn login_with_profile(
    terminal: &mut Tui,
    profile: &SavedProfile,
) -> Result<KubeSphereClient> {
    draw_message(
        terminal,
        "登录 KubeSphere",
        &format!("正在登录：{} @ {}", profile.username, profile.url),
    )?;
    let mut client = KubeSphereClient::new(ClientOptions {
        base_url: profile.url.clone(),
        insecure: profile.insecure,
    })?;
    client.login(&profile.username, &profile.password).await?;
    Ok(client)
}

fn choose_current_range(terminal: &mut Tui) -> Result<LogRange> {
    let items = vec![
        "全部当前日志".to_string(),
        "最近 1000 行".to_string(),
        "最近 N 行".to_string(),
        "最近 N 分钟".to_string(),
    ];
    let Some(index) = select_list(terminal, "当前日志", "选择日志范围", &items, 1)?
    else {
        return Err(anyhow!("已取消"));
    };
    match index {
        0 => Ok(LogRange::All),
        1 => Ok(LogRange::Tail(1000)),
        2 => {
            let lines = input_text(terminal, "当前日志", "最近多少行", "1000", false)?
                .trim()
                .parse::<u32>()
                .map_err(|_| anyhow!("行数必须是正整数"))?;
            Ok(LogRange::Tail(lines.max(1)))
        }
        _ => {
            let minutes = input_text(terminal, "当前日志", "最近多少分钟", "30", false)?
                .trim()
                .parse::<u32>()
                .map_err(|_| anyhow!("分钟数必须是正整数"))?;
            Ok(LogRange::SinceMinutes(minutes.max(1)))
        }
    }
}

fn choose_date_selection(terminal: &mut Tui) -> Result<DateSelection> {
    let items = vec![
        format!("今天 ({})", today_text()),
        "昨天".to_string(),
        "最近 N 天".to_string(),
        "指定日期".to_string(),
        "日期范围".to_string(),
    ];
    let Some(index) = select_list(terminal, "历史日志", "选择日期范围", &items, 0)?
    else {
        return Err(anyhow!("已取消"));
    };
    match index {
        0 => build_date_selection(None, None, None, None),
        1 => {
            let date = (Local::now().date_naive() - ChronoDuration::days(1))
                .format("%Y-%m-%d")
                .to_string();
            build_date_selection(Some(&date), None, None, None)
        }
        2 => {
            let days = input_text(terminal, "历史日志", "最近多少天", "3", false)?
                .trim()
                .parse::<i64>()
                .map_err(|_| anyhow!("天数必须是正整数"))?;
            build_date_selection(None, None, None, Some(days))
        }
        3 => {
            let date = input_text(
                terminal,
                "历史日志",
                "指定日期 YYYY-MM-DD",
                &today_text(),
                false,
            )?;
            build_date_selection(Some(&date), None, None, None)
        }
        _ => {
            let from = input_text(
                terminal,
                "历史日志",
                "开始日期 YYYY-MM-DD",
                &today_text(),
                false,
            )?;
            let to = input_text(terminal, "历史日志", "结束日期 YYYY-MM-DD", &from, false)?;
            build_date_range(&from, &to)
        }
    }
}

fn choose_history_files(
    terminal: &mut Tui,
    files: &[HistoryLogFile],
) -> Result<Vec<HistoryLogFile>> {
    let mut items = vec![format!("全部文件（{} 个）", files.len())];
    items.extend(files.iter().map(|file| match file.size {
        Some(size) => format!("{}  {}", file.path, format_bytes(size)),
        None => file.path.clone(),
    }));
    let Some(index) = select_list(terminal, "历史日志", "选择历史日志文件", &items, 0)?
    else {
        return Ok(Vec::new());
    };
    if index == 0 {
        Ok(files.to_vec())
    } else {
        Ok(vec![files[index - 1].clone()])
    }
}

fn choose_leqi_api(terminal: &mut Tui) -> Result<LeqiApiInfo> {
    let apis = list_leqi_apis();
    let mut query = String::new();
    let mut selected = 0usize;
    loop {
        let filtered = apis
            .iter()
            .filter(|api| leqi_matches(api, &query))
            .cloned()
            .collect::<Vec<_>>();
        if selected >= filtered.len() {
            selected = filtered.len().saturating_sub(1);
        }
        terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(1)])
                .split(area);
            let input = Paragraph::new(query.as_str())
                .block(Block::default().title("搜索接口").borders(Borders::ALL))
                .style(Style::default().fg(Color::White));
            frame.render_widget(input, chunks[0]);

            let list_items = if filtered.is_empty() {
                vec![ListItem::new("没有匹配接口")]
            } else {
                filtered
                    .iter()
                    .map(|api| ListItem::new(format_leqi_api_choice(api)))
                    .collect::<Vec<_>>()
            };
            let mut state = ListState::default();
            state.select(Some(selected));
            let list = List::new(list_items)
                .block(Block::default().title("乐企接口").borders(Borders::ALL))
                .highlight_symbol("› ")
                .highlight_style(
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                );
            frame.render_stateful_widget(list, chunks[1], &mut state);
            render_footer(frame, "输入可搜索  ↑/↓ 选择  Enter 确认  Esc 返回");
        })?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Err(anyhow!("已取消")),
            KeyCode::Up => selected = selected.saturating_sub(1),
            KeyCode::Down => selected = (selected + 1).min(filtered.len().saturating_sub(1)),
            KeyCode::Backspace => {
                query.pop();
                selected = 0;
            }
            KeyCode::Enter => {
                if let Some(api) = filtered.get(selected) {
                    return Ok(api.clone());
                }
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Err(anyhow!("已取消"))
            }
            KeyCode::Char(ch) => {
                query.push(ch);
                selected = 0;
            }
            _ => {}
        }
    }
}

fn leqi_matches(api: &LeqiApiInfo, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    api.api_identity.to_lowercase().contains(&query)
        || api.api_name.to_lowercase().contains(&query)
        || api
            .remarks
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .contains(&query)
        || api
            .module
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .contains(&query)
}

async fn run_current_download_progress(
    terminal: &mut Tui,
    mut client: KubeSphereClient,
    namespace: String,
    pod: String,
    container: String,
    range: LogRange,
    output_path: PathBuf,
) -> Result<()> {
    let progress = Arc::new(Mutex::new(ProgressSnapshot::new("当前日志")));
    let worker_progress = Arc::clone(&progress);
    let output_for_worker = output_path.clone();
    let handle = tokio::spawn(async move {
        client
            .download_log(
                &namespace,
                &pod,
                &container,
                &range,
                &output_for_worker,
                |bytes| {
                    if let Ok(mut progress) = worker_progress.lock() {
                        progress.current_bytes = bytes;
                    }
                },
            )
            .await
    });

    wait_progress(terminal, progress, handle).await?;
    let size = std::fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    wait_message(
        terminal,
        "下载完成",
        &format!(
            "已保存：{}\n大小：{}",
            output_path.display(),
            format_bytes(size)
        ),
    )
}

async fn run_history_download_progress(
    terminal: &mut Tui,
    mut client: KubeSphereClient,
    options: HistoryExportOptions,
) -> Result<()> {
    let output_path = options.output_path.clone();
    let progress = Arc::new(Mutex::new(ProgressSnapshot::new("历史日志")));
    if let Some(total) = crate::history::total_known_size(&options.files) {
        progress.lock().unwrap().total_bytes = Some(total);
    }
    let worker_progress = Arc::clone(&progress);
    let handle = tokio::spawn(async move {
        export_history_logs(&mut client, options, |item: HistoryExportProgress| {
            if let Ok(mut progress) = worker_progress.lock() {
                progress.current_bytes = item.source_bytes_processed;
                progress.total_bytes = item.total_source_bytes;
                progress.detail = format!(
                    "扫描 {}/{}  已写入 {}",
                    item.file_index,
                    item.file_count,
                    format_bytes(item.bytes_written)
                );
            }
        })
        .await
    });

    let result = wait_progress(terminal, progress, handle).await?;
    wait_message(
        terminal,
        "导出完成",
        &format!(
            "已保存：{}\n匹配文件：{}  跳过文件：{}  写入：{}",
            output_path.display(),
            result.matched_files,
            result.skipped_files,
            format_bytes(result.bytes_written)
        ),
    )
}

async fn wait_progress<T>(
    terminal: &mut Tui,
    progress: Arc<Mutex<ProgressSnapshot>>,
    handle: tokio::task::JoinHandle<Result<T>>,
) -> Result<T> {
    loop {
        let snapshot = progress.lock().unwrap().clone();
        draw_progress(terminal, &snapshot)?;
        if handle.is_finished() {
            return handle.await.context("后台任务失败")?;
        }
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Release
                    && matches!(key.code, KeyCode::Char('c'))
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                {
                    handle.abort();
                    return Err(anyhow!("已取消"));
                }
            }
        }
    }
}

fn select_list(
    terminal: &mut Tui,
    title: &str,
    subtitle: &str,
    items: &[String],
    initial: usize,
) -> Result<Option<usize>> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut selected = initial.min(items.len() - 1);
    loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(1)])
                .split(area);
            let heading = Paragraph::new(subtitle)
                .block(Block::default().title(title).borders(Borders::ALL))
                .alignment(Alignment::Left);
            frame.render_widget(heading, chunks[0]);

            let list_items = items
                .iter()
                .map(|item| ListItem::new(item.as_str()))
                .collect::<Vec<_>>();
            let mut state = ListState::default();
            state.select(Some(selected));
            let list = List::new(list_items)
                .block(Block::default().borders(Borders::ALL))
                .highlight_symbol("› ")
                .highlight_style(
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                );
            frame.render_stateful_widget(list, chunks[1], &mut state);
            render_footer(frame, "↑/↓ 选择  Enter 确认  Esc 返回");
        })?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Up => selected = selected.saturating_sub(1),
            KeyCode::Down => selected = (selected + 1).min(items.len() - 1),
            KeyCode::Enter => return Ok(Some(selected)),
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('q') => return Ok(None),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
            _ => {}
        }
    }
}

fn input_text(
    terminal: &mut Tui,
    title: &str,
    label: &str,
    default: &str,
    secret: bool,
) -> Result<String> {
    let mut value = default.to_string();
    loop {
        terminal.draw(|frame| {
            let area = centered_rect(78, 30, frame.area());
            frame.render_widget(Clear, area);
            let block = Block::default().title(title).borders(Borders::ALL);
            frame.render_widget(block, area);
            let inner = shrink(area, 2, 1);
            let display = if secret {
                "*".repeat(value.chars().count())
            } else {
                value.clone()
            };
            let text = vec![
                Line::from(Span::styled(label, Style::default().fg(Color::Cyan))),
                Line::from(""),
                Line::from(display),
                Line::from(""),
                Line::from(Span::styled(
                    "Enter 确认  Esc 取消",
                    Style::default().fg(Color::DarkGray),
                )),
            ];
            frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), inner);
        })?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Enter => return Ok(value),
            KeyCode::Esc => return Err(anyhow!("已取消")),
            KeyCode::Backspace => {
                value.pop();
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Err(anyhow!("已取消"))
            }
            KeyCode::Char(ch) => value.push(ch),
            _ => {}
        }
    }
}

fn confirm_lines(terminal: &mut Tui, title: &str, lines: &[String], default: bool) -> Result<bool> {
    loop {
        terminal.draw(|frame| {
            let area = centered_rect(82, 52, frame.area());
            frame.render_widget(Clear, area);
            let block = Block::default().title(title).borders(Borders::ALL);
            frame.render_widget(block, area);
            let mut text = lines
                .iter()
                .map(|line| Line::from(line.as_str()))
                .collect::<Vec<_>>();
            text.push(Line::from(""));
            text.push(Line::from(Span::styled(
                if default {
                    "Enter/Y 确认  N 取消"
                } else {
                    "Y 确认  Enter/N 取消"
                },
                Style::default().fg(Color::DarkGray),
            )));
            frame.render_widget(
                Paragraph::new(text).wrap(Wrap { trim: false }),
                shrink(area, 2, 1),
            );
        })?;
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Enter => return Ok(default),
            KeyCode::Char('y') | KeyCode::Char('Y') => return Ok(true),
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => return Ok(false),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Ok(false)
            }
            _ => {}
        }
    }
}

fn show_text(terminal: &mut Tui, title: &str, text: &str) -> Result<()> {
    let mut scroll = 0u16;
    loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let paragraph = Paragraph::new(text)
                .block(Block::default().title(title).borders(Borders::ALL))
                .wrap(Wrap { trim: false })
                .scroll((scroll, 0));
            frame.render_widget(paragraph, area);
            render_footer(frame, "↑/↓ 滚动  Esc 返回");
        })?;
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Enter => return Ok(()),
            KeyCode::Up => scroll = scroll.saturating_sub(1),
            KeyCode::Down => scroll = scroll.saturating_add(1),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(()),
            _ => {}
        }
    }
}

fn wait_message(terminal: &mut Tui, title: &str, message: &str) -> Result<()> {
    loop {
        draw_message(terminal, title, &format!("{message}\n\n按任意键返回"))?;
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Release {
                return Ok(());
            }
        }
    }
}

fn draw_message(terminal: &mut Tui, title: &str, message: &str) -> Result<()> {
    terminal.draw(|frame| {
        let area = centered_rect(76, 36, frame.area());
        frame.render_widget(Clear, area);
        let paragraph = Paragraph::new(message)
            .block(Block::default().title(title).borders(Borders::ALL))
            .wrap(Wrap { trim: false })
            .alignment(Alignment::Left);
        frame.render_widget(paragraph, area);
    })?;
    Ok(())
}

fn draw_progress(terminal: &mut Tui, progress: &ProgressSnapshot) -> Result<()> {
    terminal.draw(|frame| {
        let area = centered_rect(82, 36, frame.area());
        frame.render_widget(Clear, area);
        let block = Block::default()
            .title(progress.label.as_str())
            .borders(Borders::ALL);
        frame.render_widget(block, area);
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .margin(2)
            .constraints([
                Constraint::Length(3),
                Constraint::Length(3),
                Constraint::Min(1),
            ])
            .split(area);
        let elapsed = progress.started.elapsed();
        let line = progress_line(progress, elapsed);
        frame.render_widget(Paragraph::new(line).alignment(Alignment::Center), chunks[0]);
        let ratio = progress
            .total_bytes
            .filter(|total| *total > 0)
            .map(|total| (progress.current_bytes as f64 / total as f64).clamp(0.0, 1.0))
            .unwrap_or_else(|| ((elapsed.as_millis() % 1600) as f64 / 1600.0).clamp(0.05, 0.95));
        let gauge = Gauge::default()
            .gauge_style(Style::default().fg(Color::Cyan).bg(Color::Black))
            .ratio(ratio)
            .label("");
        frame.render_widget(gauge, chunks[1]);
        if !progress.detail.is_empty() {
            frame.render_widget(
                Paragraph::new(progress.detail.as_str()).alignment(Alignment::Center),
                chunks[2],
            );
        }
    })?;
    Ok(())
}

fn render_footer(frame: &mut ratatui::Frame<'_>, text: &str) {
    let area = frame.area();
    if area.height == 0 {
        return;
    }
    let footer = Rect {
        x: area.x,
        y: area.y + area.height.saturating_sub(1),
        width: area.width,
        height: 1,
    };
    frame.render_widget(
        Paragraph::new(text).style(Style::default().fg(Color::DarkGray)),
        footer,
    );
}

fn init_terminal() -> Result<Tui> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    Ok(Terminal::new(backend)?)
}

fn restore_terminal(terminal: &mut Tui) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    Ok(())
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1])[1]
}

fn shrink(area: Rect, horizontal: u16, vertical: u16) -> Rect {
    Rect {
        x: area.x.saturating_add(horizontal),
        y: area.y.saturating_add(vertical),
        width: area.width.saturating_sub(horizontal * 2),
        height: area.height.saturating_sub(vertical * 2),
    }
}

fn format_target_choice(target: &KubeTarget) -> String {
    format!(
        "{}  Deployment  ({}/{})",
        target.name, target.ready_replicas, target.desired_replicas
    )
}

fn format_pod_choice(pod: &PodSummary) -> String {
    let node = pod
        .node_name
        .as_ref()
        .map(|node| format!("  {node}"))
        .unwrap_or_default();
    format!(
        "{}  {}  ready {}  restart {}{}",
        pod.name, pod.phase, pod.ready, pod.restart_count, node
    )
}

fn format_log_range(range: &LogRange) -> String {
    match range {
        LogRange::All => "全部当前日志".to_string(),
        LogRange::Tail(lines) => format!("最近 {lines} 行"),
        LogRange::SinceMinutes(minutes) => format!("最近 {minutes} 分钟"),
    }
}

fn build_history_log_file_name(
    namespace: &str,
    workload: &str,
    pod: &str,
    date_selection: &DateSelection,
) -> String {
    format!(
        "{}_{}_history_{}_{}_{}.log",
        sanitize_file_name(namespace),
        sanitize_file_name(workload),
        sanitize_file_name(&date_selection.from),
        sanitize_file_name(pod),
        timestamp_for_file_now()
    )
}

#[derive(Debug, Clone)]
struct ProgressSnapshot {
    label: String,
    started: Instant,
    current_bytes: u64,
    total_bytes: Option<u64>,
    detail: String,
}

impl ProgressSnapshot {
    fn new(label: &str) -> Self {
        Self {
            label: label.to_string(),
            started: Instant::now(),
            current_bytes: 0,
            total_bytes: None,
            detail: String::new(),
        }
    }
}

fn progress_line(progress: &ProgressSnapshot, elapsed: Duration) -> String {
    let seconds = elapsed.as_secs_f64().max(0.001);
    let speed = progress.current_bytes as f64 / seconds;
    let amount = match progress.total_bytes {
        Some(total) => format!(
            "{} / {}",
            format_bytes(progress.current_bytes),
            format_bytes(total)
        ),
        None => format_bytes(progress.current_bytes),
    };
    format!(
        "{}   速度 {}/s   已执行 {}",
        amount,
        format_rate(speed),
        format_duration(elapsed)
    )
}

fn format_rate(bytes_per_second: f64) -> String {
    let bytes = bytes_per_second.max(0.0) as u64;
    format_bytes(bytes).replace(".0 ", " ").replace(' ', "")
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remaining = seconds % 60;
    format!("{minutes}m{remaining:02}s")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_progress_without_ascii_bar() {
        let mut progress = ProgressSnapshot::new("当前日志");
        progress.current_bytes = 5 * 1024 * 1024;
        progress.total_bytes = Some(16 * 1024 * 1024);
        let line = progress_line(&progress, Duration::from_secs(5));
        assert!(line.contains("/"));
        assert!(line.contains("速度"));
        assert!(line.contains("已执行"));
        assert!(!line.contains("---"));
        assert!(!line.contains("###"));
    }

    #[test]
    fn target_choice_shows_ready_ratio() {
        let target = KubeTarget {
            name: "tax-data-extraction-server".to_string(),
            namespace: "tax-digital".to_string(),
            selector: Default::default(),
            desired_replicas: 1,
            ready_replicas: 1,
            available_replicas: 1,
        };
        assert!(format_target_choice(&target).contains("(1/1)"));
    }
}
