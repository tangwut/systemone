# 安全问题

发现可被利用的安全问题时，请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告；不要在公开 Issue 中发布可用密钥或完整利用步骤。

本项目 API 使用 `LAYA_API_KEY`。请只在本地 `.env` 中保存密钥；小游戏的 `frontend/config.js` 也只用于本地测试，不能作为公网访问控制凭据。将服务暴露到公网前，应使用 HTTPS、限流和独立的访问控制。
