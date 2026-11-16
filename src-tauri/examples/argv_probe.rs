//! Test helper: prints its argv (excluding argv[0]) as a JSON array.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    println!("{}", serde_json::to_string(&args).expect("serialize argv"));
}
