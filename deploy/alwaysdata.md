# 免费部署：alwaysdata

alwaysdata 免费计划提供 Node.js、WebSocket、HTTPS 子域名和持久磁盘，注册只需邮箱，不需要信用卡或实名。中转只转发密文，放在这类小主机上正合适。

## 1. 注册并创建站点

1. 注册 https://www.alwaysdata.com/ 免费账号。
2. 后台 → **Web → Sites → Add a site**：
   - Type: `Node.js`
   - Command: `node server/index.js`
   - Working directory: `/home/<你的账号>/ccswitch-share`
   - Environment: `SECRET=<openssl rand -hex 32 的输出>`、`DATA_DIR=/home/<你的账号>/ccswitch-share/data`、`JOIN_CODE=<一串随机字符>`、`MAX_MEMBERS=2`
3. 记下系统分配的域名，形如 `https://<账号>.alwaysdata.net`。

## 2. 上传代码

在 alwaysdata 后台启用 SSH，然后从本机：

```bash
ssh <账号>@ssh-<账号>.alwaysdata.net
git clone https://github.com/<your>/ccswitch-share.git
cd ccswitch-share
npm ci --omit=dev
mkdir -p data
```

## 3. 验证

浏览器打开 `https://<账号>.alwaysdata.net/`，看到：

```json
{"ok":true,"service":"ccswitch-share relay"}
```

就可以了。客户端里的“中转服务器地址”填这个域名。

## 4. 备份

数据只有 `data/relay.db`（以及 WAL 文件）。定期 `scp` 回来即可；密钥都在双方电脑上，丢了数据库只影响配对/通道记录，重新配对就能恢复。

## 注意

- 免费套餐有流量和磁盘限制，两个人用完全够。
- 如果 alwaysdata 的免费计划调整，任何支持 Node 24 + WebSocket + 持久磁盘的主机都可以，`server/Dockerfile` 也能直接用。
- 不要把这个 relay 当成公网匿名代理开放给陌生人：通道 key 只发给配对的对方。
