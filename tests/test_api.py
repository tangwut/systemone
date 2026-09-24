import importlib.util
import sys
import types
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


class FakeRouter:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.loaded = []
        self.preloads = []
        self.calls = []
        self.unloaded = False
        self.instances.append(self)

    def preload(self, names=None):
        self.preloads.append(names)
        self.loaded = list(names or ["english", "multilingual", "typed-decisions"])

    def route(self, state, questions, model=None, lang=None):
        return {"model": model or ("multilingual" if lang == "zh" else "english")}

    def predict(self, state, questions, **kwargs):
        self.calls.append((state, questions, kwargs))
        return {"answers": {"department": {"choice": "billing"}},
                "routing": self.route(state, questions, **kwargs),
                "usage": {"input_tokens": 10, "output_tokens": 0}}

    def unload(self):
        self.unloaded = True
        self.loaded = []


def load_main(monkeypatch):
    # Isolate only the ML boundary: the old demo must not load real models on import.
    monkeypatch.setitem(sys.modules, "laya", types.SimpleNamespace(Router=FakeRouter))
    spec = importlib.util.spec_from_file_location("systemone_main", Path(__file__).parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_application_title_uses_project_name(monkeypatch):
    module = load_main(monkeypatch)
    assert module.app.title == "systemone API"


def test_startup_loads_once_requests_reuse_and_shutdown_unloads(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    assert callable(getattr(module, "create_app", None)), "缺少 API 应用与启动模型生命周期"
    FakeRouter.instances.clear()
    settings = module.Settings(model_root=tmp_path, api_key="test-secret")
    app = module.create_app(settings, router_factory=FakeRouter)
    assert not FakeRouter.instances
    body = {"state": "refund please", "questions": {
        "refund": {"type": "noul", "instructions": "Refund requested?"}}}
    with TestClient(app) as client:
        assert len(FakeRouter.instances) == 1
        router = FakeRouter.instances[0]
        assert len(router.preloads) == 1
        assert client.get("/health").status_code == 200
        for _ in range(2):
            result = client.post("/api/v1/systemone", json=body, headers={"Authorization": "Bearer test-secret"})
            assert result.status_code == 200
            assert result.json()["routing"]["model"] == "english"
        assert len(router.calls) == 2
        assert len(FakeRouter.instances) == 1
        assert len(router.preloads) == 1
    assert router.unloaded


BODY = {"state": "refund please", "questions": {
    "refund": {"type": "noul", "instructions": "Refund requested?"}}}
HEADERS = {"Authorization": "Bearer test-secret"}


@pytest.fixture
def service(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings(model_root=tmp_path, api_key="test-secret"), FakeRouter)
    with TestClient(app) as client:
        yield client, app.state.router


def test_missing_or_wrong_key_cannot_infer(service):
    client, router = service
    for headers in ({}, {"Authorization": "Bearer wrong"}):
        assert client.post("/api/v1/systemone", json=BODY, headers=headers).status_code == 401
    assert not router.calls


def test_local_html_can_preflight_and_call_systemone_directly(service):
    client, router = service
    preflight = client.options("/api/v1/systemone", headers={
        "Origin": "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert preflight.status_code == 200
    assert preflight.headers["Access-Control-Allow-Origin"] == "null"
    response = client.post("/api/v1/systemone", json=BODY,
                           headers={**HEADERS, "Origin": "null"})
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "null"
    assert len(router.calls) == 1


def test_bearer_token_authenticates_and_legacy_header_does_not(service):
    client, _ = service
    assert client.get("/api/v1/models", headers={"Authorization": "Bearer test-secret"}).status_code == 200
    assert client.get("/api/v1/models", headers={"X-API-Key": "test-secret"}).status_code == 401
    assert client.get("/api/v1/models", headers={"Authorization": "Basic test-secret"}).status_code == 401


def test_v1_routes_share_prefix_and_openapi_group(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings(tmp_path, "test-secret"), FakeRouter)
    spec = app.openapi()
    assert spec["paths"]["/api/v1/models"]["get"]["tags"] == ["/api/v1"]
    assert "/api/v1/systemone" not in spec["paths"]
    with TestClient(app) as client:
        assert client.post("/api/v1/systemone", json=BODY, headers=HEADERS).status_code == 200


def test_api_key_comes_from_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYA_API_KEY", "environment-test-key")
    module = load_main(monkeypatch)
    settings = module.Settings.from_env()
    assert settings.api_key == "environment-test-key"
    app = module.create_app(settings, FakeRouter)
    with TestClient(app) as client:
        assert client.get("/api/v1/models", headers={"Authorization": "Bearer environment-test-key"}).status_code == 200
        assert client.get("/api/v1/models", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_missing_environment_key_fails_startup(monkeypatch, tmp_path):
    monkeypatch.delenv("LAYA_API_KEY", raising=False)
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings.from_env(), FakeRouter)
    with pytest.raises(ValueError, match="API key must be configured"):
        with TestClient(app):
            pass


def test_default_model_root_uses_project_models(monkeypatch):
    monkeypatch.delenv("LAYA_MODEL_ROOT", raising=False)
    module = load_main(monkeypatch)
    assert module.Settings.from_env().model_root.resolve() == Path(__file__).parents[1] / "models"


def test_relative_model_root_is_resolved_from_project_directory(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYA_MODEL_ROOT", "models/")
    monkeypatch.chdir(tmp_path)
    module = load_main(monkeypatch)
    assert module.Settings.from_env().model_root == Path(__file__).parents[1] / "models"


@pytest.mark.parametrize("questions", [
    {},
    {"q": {"type": "unknown", "instructions": "x"}},
    {"q": {"type": "noul", "instructions": " "}},
    {"q": {"type": "choice", "instructions": "x", "criteria": []}},
    {"q": {"type": "choice", "instructions": "x", "criteria": ["a", "a"]}},
    {"q": {"type": "score", "instructions": "x", "criteria": {"0": "low"}}},
    {"q": {"type": "noul", "instructions": "x", "criteria": ["yes"]}},
    {"q": {"type": "choice", "instructions": "x", "criteria": list(map(str, range(21)))}},
])
def test_invalid_questions_rejected_before_inference(service, questions):
    client, router = service
    assert client.post("/api/v1/systemone", json={**BODY, "questions": questions}, headers=HEADERS).status_code == 422
    assert not router.calls


def test_busy_request_returns_503_without_second_inference(service):
    client, router = service
    entered, release = threading.Event(), threading.Event()
    original = router.predict
    def blocking(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    router.predict = blocking
    with ThreadPoolExecutor() as pool:
        first = pool.submit(client.post, "/api/v1/systemone", json=BODY, headers=HEADERS)
        assert entered.wait(3)
        try:
            assert client.post("/api/v1/systemone", json=BODY, headers=HEADERS).status_code == 503
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(router.calls) == 1


def test_request_cannot_trigger_unconfigured_model_load(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings(tmp_path, "test-secret", models=("english",)), FakeRouter)
    with TestClient(app) as client:
        response = client.post("/api/v1/systemone", json={**BODY, "model": "multilingual"}, headers=HEADERS)
        assert response.status_code == 422
        assert not app.state.router.calls


def test_inference_failure_is_sanitized_and_next_request_works(service):
    client, router = service
    original = router.predict
    router.predict = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("private checkpoint path"))
    response = client.post("/api/v1/systemone", json=BODY, headers=HEADERS)
    assert response.status_code == 500
    assert "private checkpoint" not in response.text
    router.predict = original
    assert client.post("/api/v1/systemone", json=BODY, headers=HEADERS).status_code == 200


def test_missing_key_fails_startup(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings(tmp_path, ""), FakeRouter)
    with pytest.raises(ValueError, match="API key must be configured"):
        with TestClient(app):
            pass


def test_preload_failure_unloads_and_never_reports_ready(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    class BrokenRouter(FakeRouter):
        def preload(self, names):
            raise RuntimeError("load failed")
    app = module.create_app(module.Settings(tmp_path, "test-secret"), BrokenRouter)
    with pytest.raises(RuntimeError, match="load failed"):
        with TestClient(app):
            pass
    assert not app.state.ready
    assert app.state.router.unloaded


def test_health_and_model_inventory(service):
    client, router = service
    assert client.get("/health").json()["status"] == "ready"
    assert client.get("/health/live").status_code == 404
    assert client.get("/health/ready").status_code == 404
    assert client.get("/api/v1/models").status_code == 401
    inventory = client.get("/api/v1/models", headers=HEADERS)
    assert inventory.status_code == 200
    assert inventory.json()["loaded"] == router.loaded
    assert client.post("/api/v1/systemone", json=BODY, headers=HEADERS).status_code == 200


def write_checkpoint(root):
    for filename in ("rl_agent_config.json", "model.safetensors", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "encoder/config.json"):
        path = root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}")


def test_make_router_sets_one_offline_flag(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    write_checkpoint(tmp_path)
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    module.make_router(model_root=tmp_path, model_names=("english",))
    assert module.os.environ["HF_HUB_OFFLINE"] == "1"
    assert "TRANSFORMERS_OFFLINE" not in module.os.environ


def test_cache_root_resolves_main_snapshot_without_network(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    assert hasattr(module, "resolve_model_paths"), "需要解析 Hugging Face cache 根目录"
    revision = "a" * 40
    root = tmp_path / "snapshots" / revision
    (tmp_path / "refs").mkdir()
    (tmp_path / "refs/main").write_text(revision)
    write_checkpoint(root)
    write_checkpoint(root / "multilingual")
    result = module.resolve_model_paths(tmp_path, ("english", "multilingual"))
    assert result == {"english": str(root), "multilingual": str(root / "multilingual")}


def test_incomplete_local_model_fails_before_router_construction(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    assert hasattr(module, "resolve_model_paths")
    write_checkpoint(tmp_path)
    (tmp_path / "model.safetensors").unlink()
    with pytest.raises(ValueError, match="model.safetensors"):
        module.resolve_model_paths(tmp_path, ("english",))


def test_project_model_bundle_is_complete_and_self_contained(monkeypatch):
    module = load_main(monkeypatch)
    root = Path(__file__).parents[1] / "models"
    assert set(module.resolve_model_paths(root, module.MODELS)) == set(module.MODELS)
    assert not any(path.is_symlink() for path in root.rglob("*"))


def test_large_body_rejected_before_inference(service):
    client, router = service
    response = client.post("/api/v1/systemone", json={**BODY, "state": "x" * 70000}, headers=HEADERS)
    assert response.status_code == 413
    assert not router.calls


def test_chunked_body_cannot_bypass_size_limit(service):
    client, router = service
    response = client.post("/api/v1/systemone", content=iter([b"x" * 40000, b"x" * 40000]),
                           headers={**HEADERS, "Content-Type": "application/json"})
    assert response.status_code == 413
    assert not router.calls


def test_health_not_ready_without_startup(monkeypatch, tmp_path):
    module = load_main(monkeypatch)
    app = module.create_app(module.Settings(tmp_path, "test-secret"), FakeRouter)
    client = TestClient(app)
    assert client.get("/health").status_code == 503
