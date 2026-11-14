# ccswitch-share

两个人的 API 额度共享工具，端到端加密：

- 各自在客户端里填自己的 API（Anthropic / OpenAI 兼容），Key 只留在本机。
- 用 6 位图形化配对码互换公钥，之后开一条带每日 token 上限的共享通道。
- 朋友把通道配置粘进 Claude Code / Codex，请求经本机代理 → 中转 → 对方的客户端 → 上游 API。
- 中转服务器只转发密文，**看不到 API Key、对话内容和模型**。

```
Claude Code ──> 本机代理(127.0.0.1:8788) ──密文──> 中转服务器 <──WebSocket── 对方客户端 ──> 上游 API
```

双方的客户端都要开着：出额度的一方在本机用 Key 代发请求，用额度的一方在本机解密响应。

## 本机跑起来

```bash
npm install
npm start                 # 客户端：http://127.0.0.1:8787
SECRET=dev-secret npm run relay   # 中转，本地调试用
```

客户端有两个端口：

- `8787` 图形界面（Tauri 外壳也指向这里）
- `8788` 本机代理，Claude Code / Codex 的 Base URL 填它

## 部署中转

中转只需要 Node 24、WebSocket 和一块能存 SQLite 的磁盘。不想租 VPS 的话，用 alwaysdata 免费计划（邮箱注册，不需要信用卡和实名），步骤见 [deploy/alwaysdata.md](deploy/alwaysdata.md)。

有 VPS 的话：

```bash
cp .env.example .env        # 把 SECRET 换成 openssl rand -hex 32
docker compose up -d --build
```

再用 Caddy / Nginx 加 HTTPS。中转是纯 HTTP 服务，**必须套 TLS**：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

环境变量：`SECRET`（必填，加密 share key 用）、`PORT`、`DATA_DIR`、`RETENTION_DAYS`（元数据保留天数，默认 7）、`TZ`（每日额度重置时区）。

## 使用流程

1. 双方打开客户端，填中转地址和昵称，创建身份（本机生成 ECDH 密钥，公钥上传，私钥不出本机）。
2. 一方点“生成配对码”，把 6 位数字告诉对方；对方在六个格子里输入，完成配对。
3. 出额度的一方在“我的 API”里添加供应商（协议、Base URL、Key，只存本机）。
4. 在“共享给朋友”里选 API、朋友、每日 token 上限，生成通道并复制配置。
5. 用额度的一方把配置粘进客户端，或者在“朋友的通道”里直接复制。

### Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8788
ANTHROPIC_AUTH_TOKEN=sk-share-...
```

### Codex

`~/.codex/config.toml`：

```toml
model_provider = "friend"

[model_providers.friend]
name = "friend"
base_url = "http://127.0.0.1:8788/v1"
env_key = "FRIEND_API_KEY"
```

环境变量 `FRIEND_API_KEY=sk-share-...`。

## 安全模型

- **不在服务器上的**：API Key、请求体、响应体、模型名、prompt。
- **在服务器上的**：昵称、公钥、配对关系、通道配置（供应商名/协议/日限额）、share key（加密存储，仅用于路由）、请求元数据（时间、状态、token 数、耗时）。
- 通道加密密钥由双方 ECDH（P-256）+ HKDF-SHA256 现算，中转不参与，也不保存。
- 日限额由中转按出额度方上报的 usage 累计，超出返回 429。
- 对方客户端离线时，请求返回 503，而不是挂住。

## 测试

```bash
npm test
```

覆盖：ECDH 对称性与加解密、四种 usage 解析、配对码单次/过期、完整双客户端链路（Anthropic 非流式、OpenAI 流式、限额 429、离线 503），以及“中转数据库里搜不到 prompt / 回复 / 上游 Key”的断言。

## 目录

- `client/` — 本机客户端：图形界面、本机代理、WebSocket 代理端
- `server/` — 中转：配对、通道、路由密文、用量元数据
- `shared/` — ECDH/AES-GCM 与 usage 解析
- `ui/` — 原生 HTML/CSS/JS 界面
- `src-tauri/` — 可选桌面外壳（加载 `http://127.0.0.1:8787`）
