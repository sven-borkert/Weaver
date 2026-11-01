use clap::Parser;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

fn main() {
    let args = Args::parse();
    let result = weaver_onenote_reader::arm_parent_death_signal().and_then(|()| {
        weaver_onenote_reader::run_with_deadline(args.source, args.output, Duration::from_secs(300))
    });
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
