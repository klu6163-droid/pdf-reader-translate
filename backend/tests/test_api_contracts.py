"""OpenAPI contract regression checks for critical JSON routes."""
from __future__ import annotations

from app.main import app


def _success_schema(path: str, method: str = "post") -> dict:
    return app.openapi()["paths"][path][method]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]


def test_critical_json_routes_have_named_response_models() -> None:
    expected = {
        ("/api/translate/text", "post"): "TextTranslateResponse",
        ("/api/translate/terms", "post"): "TermsExplainResponse",
        ("/api/translate/pdf/start", "post"): "StartTaskResponse",
        ("/api/overlay/pdf/start", "post"): "StartTaskResponse",
        ("/api/edit/pdf/analyze", "post"): "AnalyzePdfResponse",
        ("/api/edit/pdf/save", "post"): "SaveEditsResponse",
        ("/api/annot/pdf/open", "post"): "OpenAnnotationsResponse",
        ("/api/annot/pdf/{annot_id}/annotations", "get"): "AnnotationListResponse",
        ("/api/annot/pdf/{annot_id}/annotations", "post"): "AnnotationResponse",
        ("/api/annot/pdf/{annot_id}/annotations/{aid}", "put"): "AnnotationResponse",
        ("/api/annot/pdf/{annot_id}/annotations/{aid}", "delete"): "DeleteAnnotationResponse",
        ("/api/annot/pdf/{annot_id}/save", "post"): "SaveAnnotationsResponse",
    }
    for (path, method), model in expected.items():
        assert _success_schema(path, method) == {
            "$ref": f"#/components/schemas/{model}"
        }


def test_overlay_contract_no_longer_advertises_target_lang() -> None:
    operation = app.openapi()["paths"]["/api/overlay/pdf/start"]["post"]
    request_schema = operation["requestBody"]["content"]["multipart/form-data"]["schema"]
    component_name = request_schema["$ref"].rsplit("/", 1)[-1]
    properties = app.openapi()["components"]["schemas"][component_name]["properties"]
    assert "target_lang" not in properties


def test_full_translation_contract_keeps_target_lang() -> None:
    operation = app.openapi()["paths"]["/api/translate/pdf/start"]["post"]
    request_schema = operation["requestBody"]["content"]["multipart/form-data"]["schema"]
    component_name = request_schema["$ref"].rsplit("/", 1)[-1]
    properties = app.openapi()["components"]["schemas"][component_name]["properties"]
    assert "target_lang" in properties
