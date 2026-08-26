fn main() {
    tauri_build::build();
    link_resources_for_tests();
}

/// cargo test 生成的测试 exe 拿不到 tauri-build 经 embed-resource 注入的应用清单：
/// 那条路径只发 `rustc-link-arg-bins`（仅 bin），测试 exe 因此缺 comctl32 v6 激活，
/// 加载时找不到 `TaskDialogIndirect` 入口点（STATUS_ENTRYPOINT_NOT_FOUND，0xc0000139）。
/// 这里把同一份编译好的资源档再发给测试目标。
/// 前置条件：包内存在显式测试目标（tests/ 下的集成测试），否则
/// cargo 拒收 `rustc-link-arg-tests` 指令（lib 内 #[cfg(test)] 不算）。
fn link_resources_for_tests() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    // tauri-build/winres 产物：GNU 工具链是 libresource.a，MSVC 是 resource.lib
    for name in ["libresource.a", "resource.lib"] {
        let path = std::path::Path::new(&out_dir).join(name);
        if path.exists() {
            println!("cargo:rustc-link-arg-tests={}", path.display());
            return;
        }
    }
}
