// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 逻辑集中在 lib.rs 的 run()，以符合 Tauri v2 官方 lib + bin 模板结构。
    pdf_reader_translate_lib::run()
}
