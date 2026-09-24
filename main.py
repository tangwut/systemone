"""HTTP API for a startup-loaded, resident Laya Router."""
from __future__ import annotations

import os
import logging
import re
import secrets
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

MODELS = ("english", "multilingual", "typed-decisions")
log = logging.getLogger("systemone")


@dataclass(frozen=True)
class Settings:
    model_root: Path
    api_key: str
    models: tuple[str, ...] = MODELS
    device: str = "cpu"

    @classmethod
    def from_env(cls):
        root = Path(os.environ.get("LAYA_MODEL_ROOT", "models/")).expanduser()
        if not root.is_absolute():
            root = Path(__file__).resolve().parent / root
        return cls(root, os.environ.get("LAYA_API_KEY", ""),
                   tuple(x.strip() for x in os.environ.get("LAYA_MODELS", ",".join(MODELS)).split(",") if x.strip()),
                   os.environ.get("LAYA_DEVICE", "cpu"))


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["choice", "score", "noul"]
    instructions: str = Field(min_length=1, max_length=2000)
    criteria: dict[str, Any] | list[Any] | None = None

    @field_validator("instructions")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("instructions must not be blank")
        return value

    @model_validator(mode="after")
    def validate_criteria(self):
        c = self.criteria
        if self.type == "noul":
            if c is not None and (not isinstance(c, dict) or set(c) - {"true", "false"}):
                raise ValueError("noul criteria must be a true/false mapping")
        else:
            if not c or not 1 <= len(c) <= 20:
                raise ValueError("choice/score requires 1 to 20 criteria")
            if self.type == "score" and not isinstance(c, list):
                raise ValueError("score criteria must be an ordered list")
            if self.type == "choice":
                labels = list(c)
                if not all(isinstance(x, str) and x.strip() for x in labels):
                    raise ValueError("choice labels must be nonempty strings")
                if len(set(labels)) != len(labels):
                    raise ValueError("choice labels must be unique")
        return self


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str | dict | list
    questions: dict[str, Question] = Field(min_length=1, max_length=20)
    model: Literal["english", "multilingual", "typed-decisions"] | None = None
    lang: str | None = Field(default=None, min_length=2, max_length=32)


def resolve_model_paths(root: Path, names: tuple[str, ...]) -> dict[str, str]:
    root = root.expanduser().resolve()
    if (root / "snapshots").is_dir():
        ref = root / "refs/main"
        if not ref.is_file():
            raise ValueError("Cache has no refs/main; set LAYA_MODEL_ROOT to a specific snapshot")
        revision = ref.read_text().strip()
        if not re.fullmatch(r"[a-fA-F0-9]{40}", revision):
            raise ValueError("Invalid cache revision in refs/main")
        root = root / "snapshots" / revision
    paths = {}
    for name in names:
        directory = root if name == "english" else root / name
        required = ("rl_agent_config.json", "model.safetensors", "tokenizer/tokenizer.json",
                    "tokenizer/tokenizer_config.json", "encoder/config.json")
        missing = [item for item in required if not (directory / item).is_file()]
        if missing:
            raise ValueError(f"Incomplete local model {name} at {directory}: missing {', '.join(missing)}")
        paths[name] = str(directory)
    return paths


def make_router(*, model_root: Path, model_names: tuple[str, ...], **kwargs):
    # Resolve and validate everything before constructing any model. No Hub IDs are used.
    paths = resolve_model_paths(model_root, model_names)
    os.environ.setdefault("USE_TF", "0")
    os.environ.setdefault("USE_TORCH", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    from laya import Router
    return Router(models=paths, **kwargs)


class BodyLimitMiddleware:
    """Bound buffered HTTP bodies, including requests without Content-Length."""

    def __init__(self, app, max_bytes=65536):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.max_bytes:
                response = JSONResponse({"detail": "Request body exceeds 64 KiB"}, status_code=413)
                return await response(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        pending = True

        async def replay():
            nonlocal pending
            if pending:
                pending = False
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, router_factory=make_router):
    inference_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app):
        config = settings or Settings.from_env()
        if not config.api_key.strip():
            raise ValueError("API key must be configured")
        if not config.models or set(config.models) - set(MODELS) or len(set(config.models)) != len(config.models):
            raise ValueError("LAYA_MODELS must contain unique supported model names")
        app.state.settings = config
        log.info("Loading resident models: %s; requested device: %s", config.models, config.device)
        router = await run_in_threadpool(router_factory, model_root=config.model_root,
                                         model_names=config.models, device=config.device,
                                         max_loaded=len(config.models), preload=False)
        app.state.router = router
        app.state.ready = False
        try:
            await run_in_threadpool(router.preload, list(config.models))
            app.state.ready = True
            log.info("Models ready: %s", router.loaded)
            yield
        finally:
            app.state.ready = False
            def unload():
                with inference_lock:
                    router.unload()
            await run_in_threadpool(unload)

    app = FastAPI(title="systemone API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["POST"],
                       allow_headers=["Authorization", "Content-Type"])
    app.state.ready = False

    bearer = HTTPBearer(auto_error=False)

    def authenticate(credentials: HTTPAuthorizationCredentials | None = Security(bearer)):
        if not app.state.ready:
            raise HTTPException(503, "Models are not ready")
        token = credentials.credentials if credentials else ""
        if not secrets.compare_digest(token.encode(), app.state.settings.api_key.encode()):
            raise HTTPException(401, "Invalid bearer token", headers={"WWW-Authenticate": "Bearer"})

    @app.get("/health", include_in_schema=False)
    def ready():
        if not app.state.ready:
            raise HTTPException(503, "Models are not ready")
        return {"status": "ready", "models": app.state.router.loaded}

    apiv1_router = APIRouter(prefix="/api/v1", tags=["/api/v1"], dependencies=[Depends(authenticate)])

    @apiv1_router.get("/models")
    def models():
        return {"loaded": app.state.router.loaded, "device_requested": app.state.settings.device}

    @apiv1_router.post("/systemone", include_in_schema=False)
    def predict(body: PredictRequest):
        router = app.state.router
        questions = {key: value.model_dump(exclude_none=True) for key, value in body.questions.items()}
        decision = router.route(body.state, questions, model=body.model, lang=body.lang)
        if decision["model"] not in app.state.settings.models:
            raise HTTPException(422, "Selected model is not enabled; use a preloaded model")
        if not inference_lock.acquire(blocking=False):
            raise HTTPException(503, "Model is busy; retry later", headers={"Retry-After": "1"})
        try:
            result = router.predict(body.state, questions, model=decision["model"], lang=body.lang)
            result["routing"] = dict(decision)
            return result
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, "Question could not be evaluated; check criteria and token budget")
        except Exception:
            log.exception("Model inference failed")
            raise HTTPException(500, "Model inference failed")
        finally:
            inference_lock.release()

    app.include_router(apiv1_router)
    return app


app = create_app()


if __name__ == "__main__":
    from dotenv import load_dotenv
    import uvicorn
    load_dotenv(Path(__file__).with_name(".env"))
    uvicorn.run(app, host=os.environ.get("LAYA_HOST", "127.0.0.1"),
                port=int(os.environ.get("LAYA_PORT", "8000")),
                workers=1, limit_concurrency=16)
