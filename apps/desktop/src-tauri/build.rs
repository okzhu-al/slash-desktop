fn main() {
    println!("cargo:rerun-if-changed=capabilities/default.json");
    tauri_build::build()
}
