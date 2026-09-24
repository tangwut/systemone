# SystemOne 小游戏

目录：

- `tetris/`：俄罗斯方块；SystemOne 每个方块选择一次落点。
- `snake/`：贪吃蛇；SystemOne 每移动一格选择一次方向。
- `config.example.js`：本地 API Key 的空白示例；复制为不提交的 `config.js`。

先在项目根目录启动现有 API：

```bash
python main.py
```

先复制 `frontend/config.example.js` 为 `frontend/config.js`，并将其中的空字符串改为本机 `.env` 里的 `LAYA_API_KEY`。等待 `/health` 就绪，然后直接双击 `frontend/tetris/index.html` 或 `frontend/snake/index.html`。页面直接请求 `http://127.0.0.1:8000/api/v1/systemone`，无需额外前端服务。`main.py` 允许本地 `file://` 页面所用的 `Origin: null` 跨域请求。`config.js` 仅供本地演示，不能保护公网密钥。

两个游戏都会先用本地规则生成安全候选，再由 SystemOne 做最终选择，页面显示候选、模型返回概率、原始请求与响应及移动记录。模型概率不能当成游戏胜率。模型无法响应时游戏暂停并显示错误。

测试：

```bash
node --test frontend/tetris/tests/core.test.mjs frontend/snake/tests/core.test.mjs
python -m pytest -q
```
