# 从零部署到自己的飞书

目标：你自己的 D3200 → 你自己的飞书应用 → 你自己的服务器和语音 API → 你自己的私人飞书文档。

推荐按顺序完成。文中的 `record.example.com`、`cli_REPLACE_ME` 等都是示例，必须替换；不能把作者或其他应用的 ID 拿来使用。

## 1. 准备材料

| 需要什么 | 用途 |
| --- | --- |
| Soundcore D3200 录音豆和可用的 iPhone 飞书 | 设备取音；其他组合自行验证 |
| 可创建企业自建应用的飞书组织 | 网页入口、端内登录、JSAPI 和云文档 |
| 可管理应用权限、发布版本的管理员 | 让自己的账号能在手机工作台打开应用 |
| Linux 服务器、域名和 HTTPS | 手机和服务商能访问；浏览器蓝牙链路由飞书提供 |
| StepFun API Key | 实时或录后识别，以及总结、章节和翻译 |
| 豆包语音应用 App ID、Access Token（可选） | 切换豆包实时/录后识别 |

本教程用独立 Linux 服务器上的 Python + systemd + Caddy。域名 DNS A/AAAA 指向这台服务器，放通 80/443。不要配置一个不能连通的 AAAA 记录。8897 只监听本机，不向公网开放。已有网站可只合并这里的独立路径规则；不要直接覆盖别人的 Caddy 配置。

## 2. 创建飞书网页应用

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)，选择正确组织，创建**企业自建应用**。
2. 名称填写「录音豆」，上传自己有权使用的图标，填写用途说明。
3. 在「凭证与基础信息」记录这一个应用的 **App ID** 和 **App Secret**。App ID 是应用标识，App Secret 是密码性质的秘密。
4. 在「添加应用能力」启用**网页应用**。本教程不需要机器人、小程序打包或事件订阅。
5. 在网页应用配置中，移动端主页填写 `https://你的域名/minutes/h5/index.html`。需要桌面端入口时也可填同一地址，但桌面端打开不表示支持设备蓝牙。
6. 在安全设置/网页应用的可信域名设置中添加 `https://你的域名`，按后台字段要求填写协议或纯域名。这里与服务端 `origin` 必须指向同一个站点。
7. 保存配置。权限修改和应用名称修改后，还需要创建并发布新版本才对手机生效。

H5 指普通网页；JSAPI 是飞书向网页提供的原生能力接口。程序会从服务端取得当前页面的签名，再使用飞书 SDK 连接蓝牙。不能把 App Secret 放进网页，也不能仅通过普通 Safari 打开链接完成这条蓝牙链路。[飞书网页应用开发说明](https://open.feishu.cn/document/client-docs/h5/development-guide/step-3)

## 3. 配置所需权限

在同一应用「权限管理」中启用**应用身份**权限，再发布版本。这份代码创建并写入新版云文档、检查私有设置、把本人添加为协作者，用到：

| 权限 | 用途 |
| --- | --- |
| `docx:document` | 创建、读取和写入新版文档 |
| `docs:permission.member:create` | 将配置的本人加入文档协作者 |
| `docs:permission.setting:read` | 回读文档分享设置 |
| `docs:permission.setting:write_only` | 关闭链接分享和外部访问 |

暂时只验收录音、不要自动生成文档，可在后面的 `settings.json` 中将 `documentsConfig` 设为 `""`，先跳过这四项。需要复现自动文档效果时再补齐。

后台权限名称可能随平台更新调整；以对应 API 文档的「权限要求」为准：[创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)、[修改公共权限](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/patch)、[获取公共权限](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/get)、[增加协作者](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/create)。不要直接申请全部通讯录或全部云盘权限。

## 4. 取得自己的两个身份标识

它们不同，不能混填：

| 标识 | 配置位置 | 含义 |
| --- | --- | --- |
| `ownerOpenId`，形如 `ou_…` | `secrets/identity.json` | 你在**当前应用**内的用户 ID，用于免口令登录 |
| `ownerUserId` | `secrets/documents.json` | 你在当前组织里的 `user_id`，用于接收私人文档 |

1. 打开飞书开放平台的 **API 调试台**，确认右上角选择的是刚创建的应用和正确组织。
2. 选择带 `user_id_type`/`member_id_type` 的用户相关接口，在类型下拉中选 `open_id`，通过用户选择器在组织架构中选自己，再点「复制成员 ID」。不需要为了复制 ID 真正发起该接口请求。
3. 保持同一应用和同一成员，切换类型为 `user_id` 后复制，供文档配置使用。
4. 如果组织隐藏了成员选择器或不允许取得 user_id，请组织管理员提供**你本人的组织 user_id**。另一条官方方式是「通过手机号或邮箱获取用户 ID」；该方式需要相应通讯录权限和可访问范围，按官方文档申请，不要用其他应用的 open_id 代替。

官方说明：[获取 Open ID 的方法与跨应用错误](https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code)、[通过手机号或邮箱获取用户 ID](https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id)。这些值只保存到本机配置，不提交到 Git。

## 5. 安装服务器运行环境

以下命令以 Debian/Ubuntu 为例，在**你自己的服务器**执行。目录统一为 `/opt/luyindou`：

```sh
sudo apt-get update
sudo apt-get install -y git python3 python3-venv libopus0 caddy
sudo useradd --system --user-group --home-dir /opt/luyindou --shell /usr/sbin/nologin luyindou
sudo git clone https://github.com/mcncarl/luyindou.git /opt/luyindou
cd /opt/luyindou
sudo python3 -m venv .venv
sudo .venv/bin/python -m pip install -r server/requirements.txt
sudo install -d -m 0700 -o luyindou -g luyindou data secrets
sudo cp config/settings.example.json config/settings.json
sudo cp config/identity.example.json secrets/identity.json
sudo cp config/documents.example.json secrets/documents.json
sudo chmod 0600 config/settings.json secrets/identity.json secrets/documents.json
```

如果该系统用户或目录已经存在，先核对用途，跳过相应的创建命令。若发行版软件源没有 Caddy，按 [Caddy 官方安装指南](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装，不要下载来源不明的安装脚本。

仓库私有时，先使用自己的 GitHub 权限克隆，或把本地源码上传到该目录；不要把 GitHub token 写进 clone URL。

## 6. 填配置并保存秘密

用编辑器打开三个文件（例如 `sudo nano config/settings.json`），按下面填写：

- `settings.json`：填自己的 `appId` 和 `origin`。`origin` 只写 `https://你的域名`，末尾不加 `/`；`basePath` 保持 `/minutes`。其余路径使用模板即可。
- `identity.json`：`appId` 与前面完全一致；`ownerOpenId` 填步骤 4 取得的当前应用 Open ID。
- `documents.json`：`ownerUserId` 填组织 user_id；`docBaseUrl` 填你打开云文档时地址栏里的域名，例如 `https://your-team.feishu.cn`，不要附带 `/docx/...`。

在命令行用隐藏输入保存密钥，值不会出现在命令参数里：

```sh
sudo .venv/bin/python tools/save_secret.py secrets/feishu-app-secret
sudo .venv/bin/python tools/save_secret.py secrets/stepfun-key
sudo chown luyindou:luyindou config/settings.json
sudo chown -R luyindou:luyindou secrets data
sudo -u luyindou .venv/bin/python tools/run.py --check
```

看到 `Configuration is valid. No external API was called.` 才继续。检查只验证本地格式、路径和权限，不验证账号余额或远端授权。文件保存工具拒绝覆盖已有文件；轮换密钥时用本机编辑器修改对应文件，保持 0600。

无需手工创建维护口令：程序首次启动会在 `secrets/access-token` 生成随机值。正常手机使用走飞书账号免登录，不需要把这个口令发给别人。

### 可选：豆包语音

在 [火山引擎语音控制台](https://console.volcengine.com/speech/app)创建并开通自己的实时语音识别、录音文件识别服务。将语音应用 App ID 填入 `settings.json` 的 `volcAppId`，将 `volcTokenFile` 设为 `secrets/volc-token`，再执行：

```sh
sudo .venv/bin/python tools/save_secret.py secrets/volc-token
sudo chown luyindou:luyindou secrets/volc-token
sudo -u luyindou .venv/bin/python tools/run.py --check
```

当前代码用的资源 ID 为 `volc.seedasr.sauc.duration`（实时）和 `volc.seedasr.auc`（录后）。确认自己的语音应用开通对应能力；**不是**火山通用云 API 的 AccessKey/SecretKey。未配置时页面不提供豆包选项。总结、章节和翻译仍通过 StepFun，因此不能省掉 StepFun Key。

## 7. 启动服务和 HTTPS

先安装 systemd 服务：

```sh
sudo install -m 0644 deploy/luyindou.service /etc/systemd/system/luyindou.service
sudo systemctl daemon-reload
sudo systemctl enable --now luyindou
sudo systemctl status luyindou --no-pager
```

看到 `active (running)` 后，将 `deploy/Caddyfile.example` 的站点域名替换为自己的域名，合并到 `/etc/caddy/Caddyfile`。独立新服务器可直接以该模板为配置；已有业务必须保留已有站点。随后：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -i https://你的域名/minutes/healthz
curl -i https://你的域名/minutes/api/recordings
```

预期健康检查 HTTP 200，未登录录音 API HTTP 401。网页跳转登录是正常现象。Caddy 保留 `/minutes` 前缀并支持 WebSocket；不要用会剥掉前缀的 `handle_path`。模板会重写来源 IP 头，避免客户端伪造登录限流地址。[Caddy reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

失败时先查 `sudo journalctl -u luyindou -n 50 --no-pager`，不要把完整配置或诊断文件直接贴到公开 issue。

## 8. 发布飞书内部版本

1. 回到同一自建应用，核对移动端主页、可信域名和权限均已保存。
2. 打开「版本管理与发布」→「创建版本」，填写版本号和说明。
3. 应用可用范围**先只选自己**。这是单人录音库，不要开放给全组织。
4. 提交发布；需要管理员审批时完成审批，等待后台明确显示已发布。保存配置不等于发布完成。
5. 在 iPhone 飞书切换到对应组织，进入工作台搜索「录音豆」。若不在常用区，通过添加应用/全部应用找到它。
6. 从工作台打开，验证进入录音列表，没有维护口令输入框。若显示仅本人可用或授权失败，查 App ID、Open ID 与应用可用范围。

然后按 [底部导航教程](NAVIGATION.md)固定入口，再按 [录音验收步骤](USAGE.md)做第一段短录音。手机实际完成保存、退出重开和播放后，才算你自己的设备部署验收通过。
