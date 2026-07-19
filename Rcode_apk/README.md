# Rcode Android

Rcode 的安卓聊天与远程控制客户端。0.9.0 采用明亮、宽松的 ChatGPT 风格视觉体系：白色主面、深色文字、低饱和灰层级和蓝色单一强调色，配合圆形顶部按钮、28–30dp 大圆角输入框与约 80% 屏宽侧栏。聊天支持独立多会话、接口/模型/思考强度切换和实时回复；聊天与 Code 共用同账号的接口目录和模型选择，接口既可从电脑端同步，也可在手机端只填写 URL 与 API Key 后自动发现模型。Code 仅在同账号电脑在线时解锁，并直接进入“项目 → 会话”的完整 Agent 工作区。

## 当前范围

- 统一账号登录、注册与会话恢复。
- 聊天模式支持保存 OpenAI 兼容 Base URL、文本/图片模型和加密 API Key，并在电脑离线时聊天或生成图片。
- 输入框可切换图片模式，选择同步的图片模型并在消息流中直接预览生成结果。
- Code 模式只在同账号电脑在线且就绪时开放。
- ChatGPT 式侧边抽屉统一展示模式、最近会话、任务和账号入口。
- 同账号设备发现和在线状态。
- 选择电脑端公开的本地项目，不接受手机端传入任意文件路径。
- 浏览已有会话或从手机新建会话，并保留独立上下文。
- 在会话内切换电脑端当前可用的模型。
- 支持电脑端的默认、仅规划、工作区、自定义和完全访问五种权限模式。
- 支持快速、均衡、深度三档思考强度。
- 任务中心集中查看所有电脑的运行记录和实时状态。
- 实时返回工作流、计划、工具、文件变更、上下文、用量、学习状态、文本结果和错误。
- 网络切换、应用回到前台与连接失活时自动恢复远程通道。
- 本地缓存账号、设备和最近任务；离线时仍可查看上次同步状态。
- 高风险操作继续使用电脑端权限系统，手机只能批准或拒绝单次请求。
- 不提供任意远程 shell，也不绕过电脑端权限规则。

服务端实现在仓库根目录的 `Fwq/`，并已部署到 Cloudflare。移动端通过 `VITE_AUTH_API_URL` 连接账号与远程中继服务。

## 开发

```bash
npm install
npm run dev
```

构建 Web 资源并同步 Android 工程：

```bash
npm run android:sync
```

在 Android Studio 中打开 `android/`，或运行：

```bash
npm run apk:debug
```

Gradle 原始 Debug APK 输出到：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

构建脚本会把按版本命名的验收包统一复制到：

```text
../artifacts/mobile/Rcode-android-<version>-debug.apk
```

当前版本为 0.9.0（versionCode 16）。`artifacts/` 是本地构建产物目录，不纳入版本控制。

在 macOS 上，`apk:debug` 会优先使用 Android Studio 自带的兼容 JDK，避免系统 Java 版本过新导致 Gradle 无法启动。

## 服务地址

默认连接已经部署的 Rcode Remote Server。需要切换环境时复制 `.env.example` 为 `.env.local`，然后设置：

```env
VITE_AUTH_API_URL=https://lxqandlzy.me
```
