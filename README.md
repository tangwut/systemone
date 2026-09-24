# systemone — 本地常驻的 SystemOne API 与小游戏

基于 [Laya](https://pypi.org/project/laya/) 的本地推理服务。启动时从 `models/` 预加载英语、多语和 typed-decisions 三个模型；加载完成后通过 HTTP API 复用。`frontend/` 还提供俄罗斯方块和贪吃蛇示例，逐步展示模型的决策。

演示：[俄罗斯方块](tetris.gif) · [贪吃蛇](snake.gif)。动图文件较大，此处提供链接以便按需查看。

模型来自 [Convai Innovations 的 Laya 仓库](https://huggingface.co/convaiinnovations/laya)，按 Apache-2.0 许可证发布。本仓库用 Git LFS 保存约 2.2 GB 的模型权重；克隆前请安装 Git LFS。项目代码使用 [MIT 许可证](LICENSE)，模型文件使用随模型提供的 [Apache-2.0 许可证](models/LICENSE)，来源和校验值见 [模型来源清单](MODEL_PROVENANCE.md)。

## 启动

需要 Python 3.12、Git LFS 和足够容纳三个模型的内存。克隆仓库后确认 LFS 权重已拉取，再复制配置并生成自己的 API Key：

```bash
git lfs install
git clone https://github.com/OWNER/REPO.git
cd REPO
git lfs pull
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

将生成的值填入 `.env` 的 `LAYA_API_KEY`，然后运行 `python main.py`。Windows 使用 `.venv\Scripts\activate` 和 `copy .env.example .env`。`.env` 不应提交到仓库。进程实际环境变量优先于 `.env`。

| 配置 | 含义 |
| --- | --- |
| `LAYA_MODEL_ROOT` | 模型目录，默认 `models/`；相对路径以项目目录为基准，也可指定 Hugging Face cache 根目录 |
| `LAYA_MODELS` | 启动加载列表，默认 `english,multilingual,typed-decisions` |
| `LAYA_DEVICE` | 当前配置 `cpu`；可根据设备改为 `cuda` / `mps` |
| `LAYA_HOST` / `LAYA_PORT` | 默认 `127.0.0.1:8000`；需要局域网访问时自行调整监听地址 |
| `LAYA_API_KEY` | 必填，Bearer 认证密钥；缺失时启动失败 |

缓存根目录通过 `refs/main` 定位到 `snapshots/<revision>`。也可以将 `LAYA_MODEL_ROOT` 指向固定快照，实现版本固定。英语使用根目录，其他模型使用 `multilingual/` 和 `typed-decisions/` 子目录。缺少配置、权重、tokenizer 或 encoder 文件会启动失败，不会改为在线下载。完整快照中的 tokenizer 配置可能被 Laya 做兼容性修正，启动时须有写权限。

三个模型会占用数 GB 内存，首次启动需要等待。CPU 不是 README 宣传的 T4 32.8 ms 场景，应以本机实际调用为准。Laya 可能因设备不可用或显存问题回退到 CPU，注意启动日志。

**保持一个 worker，不要使用 `--reload`。** 多 worker 会各自加载一套模型。服务同时执行一条推理请求，其他同时到达的推理请求返回 503 和 `Retry-After: 1`，调用方可带随机退避重试。当前没有跨请求动态组批。

## API

| 方法与路径 | 认证 | 用途 |
| --- | --- | --- |
| `GET /health` | 无 | 模型就绪状态；未就绪返回 503 |
| `GET /api/v1/models` | `Authorization: Bearer <token>` | 常驻模型列表及请求设备 |
| `POST /api/v1/systemone` | `Authorization: Bearer <token>` | 推理 |
| `GET /docs` | 无 | Swagger UI；v1 路由按组展示，推理接口不在文档中 |

输入例子：

```json
{
  "state": {"message": "我被重复扣款了，请退款。"},
  "lang": "zh",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which department should handle this request?",
      "criteria": {"billing": "payments and refunds", "technical": "bugs and outages"}
    },
    "refund_requested": {
      "type": "noul",
      "instructions": "Does the customer request a refund?"
    }
  }
}
```

`state` 接受字符串、对象或列表。`questions` 为 1–20 个问题，每个必须提供 type 和 instructions：

- `choice`：criteria 为不重复的字符串列表，或标签到描述的对象，1–20 项。
- `score`：criteria 为有顺序的等级列表，1–20 项，结果是索引期望值。
- `noul`：criteria 可省略，或提供 true/false 描述对象；返回值是命题为真的概率。

单个请求体上限 64 KiB（包括 chunked 请求），超出返回 413。未知字段和无效问题返回 422；密钥错误返回 401；模型繁忙/未就绪返回 503；推理内部故障返回不包含内部细节的 500。

可选 `model` 为 `english`、`multilingual`、`typed-decisions`；它优先于 `lang`。省略 model 时按语言自动选择英语或多语模型。typed-decisions 需显式指定。路由选中未配置的模型会返回 422，不会在请求中懒加载。比如只预加载 multilingual 时，调用方应明确传 `model: "multilingual"`。

输出保留 Laya 的 `answers`、`usage`、`routing` 格式。`noul` 不是布尔值；choice/score 的 confidence 是熵分数，不能当作统一的答对概率。长输入仍受模型 token 预算截断，64 KiB 限制不代表模型能读取这么长的上下文。

## 调用

本地 Python 客户端读取 `.env` 中的 API Key：

```bash
python example_client.py
python example_client.py "Please refund the duplicate charge."
python example_client.py --url http://服务器内网IP:8000
```

其他调用方也可以用 curl，把 `YOUR_API_KEY` 替换为自己的密钥：

```bash
curl http://服务器内网IP:8000/api/v1/systemone \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state":"请退款","model":"multilingual","questions":{"refund":{"type":"noul","instructions":"Does the customer request a refund?"}}}'
```

局域网访问使用服务器 IP，不能使用 `0.0.0.0` 或调用方自己的 `127.0.0.1`。公网部署使用 HTTPS 反向代理（代理在同一机器时可让后端监听 127.0.0.1），并配置防火墙、限流和请求读取超时。此项目不会自动创建公网入口或系统开机服务。

停止前台服务按 Ctrl+C。停止后释放 Router 引用；下一次启动重新加载。需要长期守护时，可由 systemd / launchd / 容器管理进程。

## Docker（本机 arm64 CPU）

构建前必须运行 `git lfs pull`，确保 `models/` 中是实际权重而非 LFS 指针；镜像内模型路径为 `/app/models`。Dockerfile 当前针对本地 arm64 CPU 场景。

```bash
docker build --platform linux/arm64 -t systemone:local .
docker run --rm --name systemone --env-file .env -p 8001:8000 systemone:local
```

本机 8000 端口已有非容器服务时，使用上面的 8001 映射。等待三个模型预加载完成后，访问 `http://127.0.0.1:8001/health`；成功时返回 `status: ready`。调用 API 时，使用 `.env` 中的 `LAYA_API_KEY` 作为 Bearer token。首次启动需要加载约 2.2 GB 模型文件，容器应分配足够内存。

## 验证

```bash
python -m pip install -r requirements-ci.txt
python -m pytest -q
node --test frontend/tetris/tests/core.test.mjs frontend/snake/tests/core.test.mjs
```

API 测试只替换模型计算边界，真实执行 HTTP、鉴权、参数校验、生命周期和并发控制。真实模型启动和请求另行验证；单元测试通过不代表模型预测准确率。小游戏使用方法见 [frontend/README.md](frontend/README.md)。贡献和安全报告方式分别见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。
