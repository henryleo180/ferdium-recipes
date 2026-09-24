# ChatGPT Multi（多账号 ChatGPT）

一个小巧的桌面程序：像 Chrome 一样用**标签页**打开多个 ChatGPT，**每个标签都是完全独立的登录环境**——标签 A 登录账号 A，标签 B 登录账号 B，互不干扰。还可以**分屏**，把几个账号并排放在同一个窗口里同时用。

支持 Windows、macOS、Linux。非官方工具，与 OpenAI 无关。

## 功能

- **多账号同时在线**：每个标签有自己的 Cookie、登录状态、本地存储和缓存，互相看不到。
- **分屏**：点工具栏的分屏按钮（或 `Ctrl+Shift+E`），所有账号并排显示；点哪个窗格，哪个就是当前账号（带颜色边框）。
- **记住登录**：关掉再打开，各标签仍然是登录状态，不用重新登录。
- **标签管理**：`+` 添加账号；双击标签重命名（比如“工作号”“个人号”）；右键标签可以“退出登录”或“删除此账号标签”。
- **和浏览器配合**：聊天里的外部链接自动用系统默认浏览器（如 Chrome）打开；工具栏 `↗` 按钮把当前页面在默认浏览器中打开。
- **快捷键**（macOS 把 `Ctrl` 换成 `⌘`）：

  | 操作 | 快捷键 |
  | --- | --- |
  | 添加账号标签 | `Ctrl+T` |
  | 切换到第 1–9 个账号 | `Ctrl+1` … `Ctrl+9` |
  | 下一个 / 上一个标签 | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
  | 分屏开关 | `Ctrl+Shift+E` |
  | 刷新 | `Ctrl+R` |
  | 重命名当前账号 | `F2` |
  | 放大 / 缩小 / 还原 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

## 安装

### 方式一：下载安装包

安装包由本仓库的 GitHub Actions 自动构建（工作流 `.github/workflows/chatgpt-multi.yml`）：

1. 打开仓库的 **Actions** 页面。这是 fork 来的仓库，第一次需要点 “I understand my workflows, go ahead and enable them” 启用。
2. 选择 **ChatGPT Multi** 工作流，点 **Run workflow**（之后每次改动 `chatgpt-multi/` 也会自动构建）。
3. 运行完成后，在该次运行页面底部的 **Artifacts** 下载：
   - `ChatGPT-Multi-Windows`：`ChatGPT Multi-Setup-x.y.z.exe`（安装版）或 `ChatGPT Multi-Portable-x.y.z.exe`（免安装）
   - `ChatGPT-Multi-macOS`：`.dmg`（Apple 芯片选 `arm64`，Intel 选 `x64`）
   - `ChatGPT-Multi-Linux`：`.deb`（推荐）或 `.AppImage`

安装包没有商业代码签名，首次打开时系统会提示：

- **Windows**：出现 “Windows 已保护你的电脑” 时，点 **更多信息 → 仍要运行**。
- **macOS**：如果提示“无法打开”或“已损坏”，到 **系统设置 → 隐私与安全性** 点 **仍要打开**；或在终端运行
  `xattr -dr com.apple.quarantine "/Applications/ChatGPT Multi.app"`。

### 方式二：从源码运行

需要 [Node.js](https://nodejs.org/) 22 或更新版本：

```bash
cd chatgpt-multi
npm install     # 会下载 Electron（约 100 MB）
npm start
```

自己打包安装程序（需在对应系统上执行）：`npm run dist:win`、`npm run dist:mac`、`npm run dist:linux`，产物在 `dist/`。

## 能和 Chrome 同步吗？

- **聊天记录：会同步。** 聊天记录保存在 OpenAI 的服务器上，跟着账号走。在本软件和 Chrome 里登录同一个账号，看到的是同一份记录，在哪边聊都会出现在另一边。
- **登录状态 / Cookie / 保存的密码：不会从 Chrome 读取，也不建议这么做。** Chrome 把这些数据加密保存（Windows 上从 Chrome 127 起还有“应用绑定加密”，专门阻止其它程序读取）。能绕过它、读出 Chrome 登录凭据的程序，用的正是盗号木马的手法。所以本软件里每个标签自己登录一次即可，之后会一直保持登录。
- **书签、扩展程序、密码管理器：不支持。** 本软件不是 Chrome，只是专门用来开 ChatGPT 的小窗口。
- **想要“真正的 Chrome 同步”？** Chrome 自带的 **个人资料（Profiles）** 也能做到多账号：每个个人资料有独立的 Cookie，可以分别登录 A、B 账号，并各自开启 Chrome 同步；再在每个个人资料里用菜单 `⋮ → 投放、保存和分享 → 将页面作为应用安装`（不同版本名称可能略有不同）把 ChatGPT 装成独立窗口。区别是：那样得到的是多个独立窗口，而不是一个窗口里的标签和分屏。

## 安全设计

- **账号隔离**：每个账号使用独立的持久化存储分区（`persist:acct-…`），Cookie、localStorage、IndexedDB、缓存完全分开。
- **网页沙箱**：ChatGPT 页面运行在 Chromium 沙箱中，启用上下文隔离，没有 Node.js 权限，也不注入任何脚本——网页既读不到你的文件，也控制不了本软件。
- **限制跳转**：标签里只能打开 ChatGPT / OpenAI 和登录服务商（Google、Microsoft、Apple）的页面，其它网址一律交给系统浏览器打开；`file:`、`smb:` 等本地协议直接拒绝。工具栏始终显示当前网站地址，不是 ChatGPT/OpenAI 时显示为橙色。
- **最小权限**：只允许 chatgpt.com 使用剪贴板写入（复制按钮）、麦克风（语音输入）和通知；摄像头、定位、屏幕录制、读取剪贴板、USB/串口/HID 等一律拒绝。
- **不做多余的事**：没有遥测、没有自动更新、没有任何第三方运行时依赖；除了你打开的网页，软件本身不发任何网络请求（连 Chromium 默认的拼写词典下载也关掉了）。
- **打包版本加固**（Electron Fuses）：Cookie 在磁盘上加密保存（使用系统钥匙串）；禁止以 Node 模式运行，禁止通过 `NODE_OPTIONS` 或调试参数注入代码；只从经过完整性校验的 `app.asar` 加载程序。
- **删除即清除**：删除账号标签会立刻清除该账号的全部本地数据，下次启动时连数据文件夹一起删掉。
- **单实例运行**：避免两个进程同时写同一个账号的数据库。

## 数据保存在哪里

| 系统 | 位置 |
| --- | --- |
| Windows | `%APPDATA%\ChatGPT Multi` |
| macOS | `~/Library/Application Support/ChatGPT Multi` |
| Linux | `~/.config/ChatGPT Multi` |

也可以用菜单 **帮助 → 打开数据文件夹**。`profiles.json` 是账号列表，`Partitions/acct-…` 是各账号的数据。卸载后如需彻底清除，删除这个文件夹即可。

## 已知限制

- **Google 登录**：Google 有时会拦截“内嵌浏览器”里的登录，提示“此浏览器或应用可能不安全”。本软件使用标准 Chrome 标识，通常可以正常登录；如果仍被拦截，可以改用邮箱 + 密码，或 Microsoft / Apple 登录。
- **Linux**：推荐安装 `.deb`（会正确配置 Chromium 沙箱）；`.AppImage` 在 Ubuntu 24.04 等新系统上可能需要额外配置才能启动。
- 请遵守 OpenAI 的使用条款。

## 开发

```
src/main.js      主进程：窗口、账号标签、导航与权限控制、菜单
src/policy.js    安全策略：哪些网址可以在标签里打开、授予哪些权限
src/store.js     账号列表（profiles.json）
src/layout.js    单页 / 分屏布局计算
src/preload.js   标签栏页面与主进程之间唯一的桥
src/ui/          标签栏界面
```

```bash
npm test            # 单元测试
npm run test:e2e    # 端到端测试：启动真实程序，用本地假页面代替 chatgpt.com
                    # Linux 无图形界面时：xvfb-run -a npm run test:e2e
```
