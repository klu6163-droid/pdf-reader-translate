use pdf_reader_translate_lib::{
    export_diagnostics_json, extract_hostname, format_unix_millis, sanitize_backend_snapshot,
    sanitize_log_text,
};

#[test]
fn utc_formatter_handles_epoch_and_milliseconds() {
    assert_eq!(format_unix_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        format_unix_millis(1_704_067_200_123),
        "2024-01-01T00:00:00.123Z"
    );
}

#[test]
fn hostname_extraction_removes_credentials_port_and_path() {
    assert_eq!(
        extract_hostname("https://user:pass@API.Example.COM:8443/v1?q=secret"),
        Some("api.example.com".into())
    );
    assert_eq!(extract_hostname("not a host/path"), None);
}

#[test]
fn log_sanitizer_removes_exact_and_pattern_keys_and_url_details() {
    let secret = "custom-private-token".to_string();
    let base = "https://api.private.example/v1/tenant".to_string();
    let input = format!(
        "key={secret}\nbase={base}/chat/completions?document=private\nAuthorization: Bearer sk-live-secret\nsafe line"
    );
    let output = sanitize_log_text(&input, std::slice::from_ref(&secret), &[base]);
    assert!(!output.contains(&secret));
    assert!(!output.contains("sk-live-secret"));
    assert!(!output.contains("/v1/tenant"));
    assert!(!output.contains("chat/completions"));
    assert!(!output.contains("document=private"));
    assert!(output.contains("api.private.example"));
    assert!(output.contains("safe line"));
}

#[test]
fn backend_snapshot_rebuilds_exact_metadata_schema() {
    let input = serde_json::json!({
        "backend_version": "0.2.2",
        "os": "Windows",
        "arch": "AMD64",
        "pdf2zh_available": true,
        "recent_translations": [{
            "task_id": "task-1",
            "mode": "pdf2zh",
            "duration_ms": 123,
            "succeeded": true,
            "original": "UNPUBLISHED PAPER",
            "translated": "PRIVATE TRANSLATION",
            "api_key": "sk-never-export",
        }],
        "unexpected": "do not export",
    });
    let output = sanitize_backend_snapshot(&input);
    let encoded = serde_json::to_string(&output).unwrap();
    assert!(!encoded.contains("UNPUBLISHED PAPER"));
    assert!(!encoded.contains("PRIVATE TRANSLATION"));
    assert!(!encoded.contains("sk-never-export"));
    assert!(!encoded.contains("unexpected"));
    assert_eq!(
        output["recent_translations"][0],
        serde_json::json!({
            "task_id": "task-1",
            "mode": "pdf2zh",
            "duration_ms": 123,
            "succeeded": true,
        })
    );
}

#[test]
fn actual_json_export_redacts_credentials_urls_and_document_content() {
    const EXACT_KEY: &str = "sk-live-ABCdef1234567890";
    const BEARER_KEY: &str = "sk-bearer-ZYX987654321";
    const FULL_URL: &str = "https://api.xxx.com/v1/chat/completions";
    const PDF_NAME: &str = "confidential-paper-2026.pdf";
    const ORIGINAL_FRAGMENT: &str = "UNPUBLISHED_ORIGINAL_SENTENCE_42";

    let explicit_target = std::env::var_os("DIAGNOSTICS_TEST_OUTPUT").map(std::path::PathBuf::from);
    let root = explicit_target
        .as_ref()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "pdf-reader-translate-diagnostics-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
        });
    let target = explicit_target.unwrap_or_else(|| root.join("diagnostics.json"));
    let logs = root.join("fixture-logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join("backend.log"),
        format!(
            "2026-08-26T00:00:00.000Z INFO safe startup\n\
             2026-08-26T00:00:01.000Z ERROR api_key={EXACT_KEY}\n\
             2026-08-26T00:00:02.000Z ERROR request_url={FULL_URL}\n\
             2026-08-26T00:00:03.000Z ERROR Authorization: Bearer {BEARER_KEY}\n\
             2026-08-26T00:00:04.000Z ERROR pdf_filename={PDF_NAME}\n\
             2026-08-26T00:00:05.000Z ERROR original_text={ORIGINAL_FRAGMENT}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        logs.join("backend-restart.log"),
        "2026-08-26T00:00:06.000Z INFO tauri.backend restart ok\n",
    )
    .unwrap();

    let backend = serde_json::json!({
        "backend_version": "0.2.2",
        "os": "windows",
        "arch": "x86_64",
        "pdf2zh_available": true,
        "recent_translations": [{
            "task_id": "task-evidence",
            "mode": "pdf",
            "duration_ms": 321,
            "succeeded": true,
            "original_text": ORIGINAL_FRAGMENT,
            "filename": PDF_NAME,
        }],
    });
    export_diagnostics_json(
        &target,
        "0.2.2",
        Some(&backend),
        &["https://api.xxx.com/v1".to_string()],
        &[EXACT_KEY.to_string(), BEARER_KEY.to_string()],
        Some(&logs),
    )
    .unwrap();
    std::fs::remove_dir_all(&logs).unwrap();

    let exported = std::fs::read_to_string(&target).unwrap();
    for forbidden in [
        EXACT_KEY,
        BEARER_KEY,
        FULL_URL,
        "/v1/chat/completions",
        "Authorization: Bearer",
        PDF_NAME,
        ORIGINAL_FRAGMENT,
    ] {
        assert!(!exported.contains(forbidden), "leaked: {forbidden}");
    }
    assert!(exported.contains("api.xxx.com"));
    assert!(exported.contains("task-evidence"));
    println!("diagnostics_evidence={}", target.display());

    if std::env::var_os("DIAGNOSTICS_TEST_OUTPUT").is_none() {
        std::fs::remove_dir_all(root).unwrap();
    }
}
