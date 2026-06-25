use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "workctl", version, about = "日常工作工具集 TUI")]
struct Args {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _args = Args::parse();
    workctl::tui::run().await
}
