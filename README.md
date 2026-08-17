# 飞书表格 · 图片链接转图片（运营版 v2.0）

把飞书电子表格里「图片链接」单元格自动替换为单元格内嵌图片的轻量网站。
**运营版**：以文档所有者的飞书身份运行，好友把表共享给所有者后即可使用，不依赖所有者本机开机。

## 原理
- 所有者（你）在飞书开放平台建一个**企业自建应用**，用自己账号做一次 OAuth 网页授权，把 `user_access_token` 交给本服务（自动刷新）。
- 后端直连飞书开放 API：
  - 解析文档：`wiki/v2/spaces/get_node`（wiki 链接）→ `sheets/v3/.../sheets/query`（列子表）
  - 扫描：`sheets/v2/.../values/{range}` 读取整表，**基于字符串识别图片链接**（URL + 图片扩展名/图床 host），不依赖固定列
  - 转换：`sheets/v2/.../values_image` 把下载好的图片（base64）写入单元格
- 好友无需建应用、无需授权，只要把表（编辑权）共享给你的飞书账号，粘贴链接即可。

## 1. 本地运行（开发/自测）
```bash
cd feishu-link-to-image
cp .env.example .env        # 填入 FEISHU_APP_ID / FEISHU_APP_SECRET / PUBLIC_BASE
# 或直接用环境变量启动：
FLC_ACCESS_CODE=你的口令 FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx PUBLIC_BASE=http://localhost:8787 node server.js
# 打开 http://localhost:8787
```
启动后先点「用飞书账号初始化授权」完成一次性 OAuth（见第 3 节），即可使用。

## 2. 飞书应用创建与权限
1. 打开 https://open.feishu.cn → 开发者后台 → **创建企业自建应用**。
2. **凭证与基础信息** 拿到 App ID / App Secret（配置到环境变量）。
3. **开发配置 → 安全设置 → 重定向 URL** 添加：`https://<你的域名>/api/oauth/callback`（本地为 `http://localhost:8787/api/oauth/callback`）。
4. **权限管理 → API 权限** 开通：
   - `sheets:spreadsheet`（读表 + 写图片，开启即满足 write-images 权限要求）
   - `wiki:wiki`（解析 wiki 链接；若只用到 /sheets/ 直链可不加）
5. 如需他人也能用该应用：在 **可用性** 里把好友加入「可用范围」（同组织内）。
6. 权限通常需**企业管理员审批**后生效。

## 3. 一次性 OAuth 初始化（所有者）
在网站首页点「用飞书账号初始化授权」→ 浏览器跳飞书授权页 → 点同意 → 自动保存令牌。
之后令牌过期会自动用 refresh_token 续期。部署到 PaaS 后令牌存于服务器 `tokens.json`（重启不丢；若平台清空文件系统需重做一次）。

## 4. 部署到 Render（免费层，需常驻）
1. 把 `feishu-link-to-image` 目录推到 GitHub 仓库（已含 `render.yaml`、`Procfile`、`package.json`）。
2. Render 新建 **Web Service** → 关联仓库 → 用 `render.yaml` 自动配置。
3. 在 Render 控制台设置环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`PUBLIC_BASE=https://<你的render子域>.onrender.com`（必须与实际地址一致，否则 OAuth 回调校验失败）。
4. 免费层有**休眠**：一段时间无访问会休眠，下次访问自动唤醒（首请求较慢）。
5. 部署后打开网站 → 用访问口令进入 → 点「初始化授权」完成 OAuth。

## 5. 好友使用步骤
1. 在飞书里把表格（编辑权）**共享/添加协作者**为你的飞书账号。
2. 浏览器打开网站，输入访问口令。
3. 粘贴飞书文档链接 → 解析 → 选子表 → 扫描图片链接 → 确认转换。

## 已知限制
- **仅支持飞书电子表格**（多维表格 bitable 暂不支持）。
- 图片链接识别基于**单元格文本中的图片 URL**；飞书「超链接型」图片（rich_text link）在开放 API 读值中不返回 URL，故无法被扫描到——请让好友以**纯文本网址**形式粘贴图片链接（问卷星等导出默认即文本网址，适用）。
- 读取采用标准范围对齐；极稀疏超大表如有对齐偏差需在真实数据上复核。
- 转换以**所有者身份**执行，好友需先把表共享给所有者。
