// write_file 的 path 请求头解码测试（审计 3.5 配套）。
// 放集成测试而非 lib 内 #[cfg(test)]：build.rs 的 rustc-link-arg-tests
// 需要包内存在显式测试目标才会被 cargo 接受，且测试 exe 同样需要
// 应用清单资源（见 build.rs 注释）。

use pdf_reader_translate_lib::percent_decode;

#[test]
fn decode_windows_path_encoded_by_js() {
    // encodeURIComponent("C:\\Users\\Admin\\文档\\a b.pdf")
    let encoded = "C%3A%5CUsers%5CAdmin%5C%E6%96%87%E6%A1%A3%5Ca%20b.pdf";
    assert_eq!(
        percent_decode(encoded).unwrap(),
        "C:\\Users\\Admin\\文档\\a b.pdf"
    );
}

#[test]
fn decode_plain_ascii_and_unescaped_chars() {
    // encodeURIComponent 不转义 A-Z a-z 0-9 - _ . ! ~ * ' ( )
    assert_eq!(percent_decode("simple.pdf").unwrap(), "simple.pdf");
    assert_eq!(
        percent_decode("a-b_c.d~e(f).pdf").unwrap(),
        "a-b_c.d~e(f).pdf"
    );
}

#[test]
fn decode_slash_style_path() {
    // encodeURIComponent("C:/Users/test/报告.pdf")
    let encoded = "C%3A%2FUsers%2Ftest%2F%E6%8A%A5%E5%91%8A.pdf";
    assert_eq!(percent_decode(encoded).unwrap(), "C:/Users/test/报告.pdf");
}

#[test]
fn reject_incomplete_or_invalid_escapes() {
    assert!(percent_decode("bad%2").is_err()); // % 后不足两位
    assert!(percent_decode("bad%ZZ").is_err()); // 非十六进制
    assert!(percent_decode("%FF%FE").is_err()); // 解码后不是合法 UTF-8
}
