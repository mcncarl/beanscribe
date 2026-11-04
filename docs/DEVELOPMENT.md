# 本地开发与源码结构

## 安装和验证

Python 3.11+；Node.js 18+；系统必须可加载 libopus。前端依赖已随仓库提供，无需 npm install。

```sh
# macOS；Linux 使用 apt-get install libopus0
brew install opus
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt
npm run build
npm test
.venv/bin/python -m unittest discover -s server -p 'test_*.py'
python3 tools/check_release.py
```

`npm run build` 只把蓝牙模块打包为浏览器文件，没有联网和代码执行插件。改了 `lib/binary.js`、`ble-frame.js`、`feishu-ble.js`、`d3200-crypto.js`、`d3200-session.js` 后必须重新构建。

## 不用真实账号查看界面

只在本机启动静态服务器：

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

浏览器打开 `http://127.0.0.1:8080/preview.html` 可以检查当前设备页和空录音库的布局；静态服务器没有 API，不能用于录音或登录。历史固定字幕样例在 `http://127.0.0.1:8080/ui-assets/demo.html`，该样例不连接设备或语音服务，外观和功能不代表当前正式页面。当前正式页面没有 `?demo=1` 开关。

不要把这个静态服务器暴露到公网；真实使用要通过带认证的 Python 网关。

## 不用真实服务商检查网关

```sh
.venv/bin/python server/gateway.py \
  --origin http://127.0.0.1:8897 --port 8897 \
  --data work/local-smoke/recordings \
  --access-token-file work/local-smoke/access-token
```

首次运行会生成本地维护口令文件，只有当前用户可读。打开本机 `/login` 页面后可使用该口令检查空录音库。不要发起录音或生成任务；这条命令没有配置真实语音服务。正式手机模式用 `tools/run.py` 和自己的配置，它会启用飞书本人登录。

## 目录对应关系

| 路径 | 内容 |
| --- | --- |
| `preview.html`、`ui-assets/app.css` | 正式 H5 页面结构和样式 |
| `pages/index/index.js` | 录音列表、播放、搜索、修订和设备页状态 |
| `h5/minutes-runtime.js` | H5 SDK 鉴权、蓝牙会话与私有 WebSocket |
| `h5/feishu-login.js` | 飞书端内登录代码，服务端交换身份 |
| `lib/d3200-session.js` | D3200 会话、设备信息、文件读取和用户确认后的删除 |
| `lib/d3200-crypto.js` | ECDH、HKDF 和 AES-CTR 音频解密 |
| `server/gateway.py` | 会话认证、网页签名、录音保存、API、恢复与任务编排 |
| `server/stepfun.py`、`server/volc.py` | 识别服务适配器，凭据只在服务端 |
| `server/file_asr.py` | 录后文件识别、限时取音 URL、结果校验与应用 |
| `server/feishu_docs.py` | 私人文档、任务状态、权限检查和正文回读 |
| `tools/run.py` | 通用配置验证和启动入口 |
| `config/*.example.json`、`deploy/` | 可替换的配置及 Linux 运行模板 |
| `test/`、`server/test_*.py` | 合成数据、模拟飞书/识别服务与回归测试 |
| `app.*`、`pages/index/*.ttml/ttss` | 保留的原生小程序实验外壳；不是已验收的发布路线 |

## 测试数据为何可以分享

`test/fixtures/d3200-vectors.json` 的密钥和载荷是固定的合成密码学向量。它们不是设备绑定密钥。

`synthetic-opus.bin` 是 440 Hz 正弦波编码成的 332 个 20 ms Opus 包，没有人声。来源参数和文件哈希在同名 JSON 中；生成源码在 `tools/generate_synthetic_audio.py`。重新生成需先把旧生成物移到自己的备份目录；脚本不会覆盖已有文件。不同 libopus 版本的编码字节可能不同，因此解码测试检查帧数、时长与非静音信号范围，不把某台机器的 PCM 哈希当跨平台保证。

测试输出写到忽略目录 `work/`。原有部分单元测试还会使用系统临时目录，并自行管理临时内容；它们不接触部署数据。自动测试不等于真实手机、真实语音提供商或公网部署验收。

## 更新部署

先停止新录音、等待任务完成，在服务器备份 `data/`、`secrets/` 和 `config/settings.json` 到私有位置。确认工作树无需要保留的源码改动后，更新同一仓库：

仓库当前名称为 `mcncarl/beanscribe`；以下第一条命令把已有安装的远端地址更新为新名称。安装目录、Linux 用户、服务名和数据位置继续沿用 `luyindou`。

```sh
sudo git -C /opt/luyindou remote set-url origin https://github.com/mcncarl/beanscribe.git
sudo git -C /opt/luyindou pull --ff-only
sudo /opt/luyindou/.venv/bin/python -m pip install -r /opt/luyindou/server/requirements.txt
sudo -u luyindou /opt/luyindou/.venv/bin/python /opt/luyindou/tools/run.py --check
sudo systemctl restart luyindou
```

随后检查健康接口、未登录 401 和手机重开。更新不会把 `secrets/`、`data/` 或真实配置同步到仓库；不要使用强制覆盖或清理命令处理未知本地文件。
