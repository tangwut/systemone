# 模型来源与许可证

英语、多语和 typed-decisions 权重来自 [Convai Innovations / Laya](https://huggingface.co/convaiinnovations/laya)，原仓库模型卡标注 **Apache-2.0**。本项目代码的 MIT 许可证不改变这些模型文件的许可证；模型文件附有 [Apache-2.0 许可证全文](models/LICENSE)。上游仓库在本次核对时没有单独的 NOTICE 文件。

核对的上游版本：`aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8`。以下 SHA-256 与本地权重逐个比对一致：

| 文件 | SHA-256 |
| --- | --- |
| `models/model.safetensors` | `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c` |
| `models/multilingual/model.safetensors` | `9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204` |
| `models/typed-decisions/model.safetensors` | `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e` |

权重使用 Git LFS 保存。克隆者需先安装 Git LFS，再执行 `git lfs pull`；否则 Git 工作区中可能只有文本指针，API 不能加载模型。发布新模型版本时，请更新上游版本、校验值和许可证核对结果。
