# Speak Digest

[English](README.md) | [简体中文](README.zh-CN.md)

把每个 YouTube 视频变成一份可以深入学习的资料。Speak Digest 把字幕、双语翻译、AI 概览、内容讲解、视频问答、时间戳笔记和单词学习放进同一个 Chrome 侧边栏，让你可以持续学习视频中的知识和语言，同时不丢失原视频上下文。

- 把零碎字幕变成清晰、可搜索的学习资料。
- 查看原文、简体中文翻译，或中英双语对照字幕来学习语言。
- 通过全文摘要、AI 章节、重点引用和选中文本讲解建立系统理解。
- 点击字幕、概览或笔记中的时间戳，快速跳转到对应位置。
- 直接追问当前视频，并在你选择时补充网络搜索。
- 保存自动润色的时间戳笔记和可复用的单词本，方便之后复习。
- 使用自己的 API Key，数据保存在本地 Chrome 中，不包含分析统计或行为追踪。

Speak Digest 是一个需要自行提供 API Key 的开源项目，通过 GitHub 安装。目前没有上架 Chrome 应用商店，不赠送 API 额度，也没有开发者运营的服务器。

## v1.3.1 更新

- 点击 Vocabulary 中英文单词或短语的小喇叭时，播放有道词典美式音频；若无法播放则自动切换浏览器语音。
- 发音前暂停当前 YouTube 视频；离开词卡、切换视频或关闭侧边栏时停止发音。

## v1.3.0 更新

- 新增字面匹配的 Transcript 搜索，可在上一个和下一个结果之间跳转，不会改变视频播放时间。
- 同一浏览器会话内会恢复当前视频的 Transcript 阅读位置。会话存储最多保留 20 个最近视频的位置，浏览器会话结束后自动清除。
- 侧边栏只使用当前活动的 YouTube 标签页，后台 YouTube 标签页不会悄然替换你正在学习的视频。

## 让你的编程 Agent 帮你安装

你不需要看懂代码，也不需要会使用命令行。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome“加载已解压的扩展程序”使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/JackChen1220/youtube-digest

你的 Agent 应该帮你：

1. 先询问你想把项目长期保存在哪里，再下载或克隆到那里，并告诉你准确的完整路径。如果你需要建议，可以推荐 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。
2. 打开下方 Supadata 和 DeepSeek 官方页面，指导你创建自己的账号。Tavily 是可选的，只有 Ask 联网搜索才需要。
3. 指导你在 Chrome 中通过“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹。
4. 告诉你应该在扩展的“设置”页面哪个位置填写 API Key。
5. 打开一个带字幕的 YouTube 视频，确认字幕和翻译功能可以使用。

安装后请让这个文件夹留在原位。如果移动或删除它，Chrome 中加载的本地扩展会失效，需要从新的长期存放位置重新加载。

不要把 API Key 发送到 AI 对话、源代码、截图或公开消息中。请你自己在 Speak Digest 的设置页面直接填写。编程 Agent 可以告诉你填写位置，但不需要看到 Key。

## 手动安装

如果你想自己操作：

1. 打开 [github.com/JackChen1220/youtube-digest](https://github.com/JackChen1220/youtube-digest)。
2. 点击 **Code**，再选择 **Download ZIP**。
3. 选择一个长期保留的文件夹，并把项目解压到这里。可选建议是 macOS 或 Linux 上的 `~/Documents/youtube-digest`，或 Windows 上的 `%USERPROFILE%\Documents\youtube-digest`。你也可以使用其他文件夹。
4. 在 Chrome 地址栏打开 `chrome://extensions`。
5. 打开右上角的“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest.json`。
8. 如果需要，可以在 Chrome 扩展菜单中固定 Speak Digest。

这是一个本地加载的扩展，不会自动更新。下载新版或让 Agent 修改代码后，请在 `chrome://extensions` 中找到 Speak Digest 并点击“重新加载”，然后刷新已经打开的 YouTube 页面。如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。

## 设置 API Key

Speak Digest 需要你在自己的服务账号中准备两个必需 Key，以及一个可选 Key：

1. **Supadata API Key**，用于获取 YouTube 字幕。
2. **DeepSeek API Key**，用于生成概览、讲解内容、Ask、翻译、单词信息和自动润色笔记。
3. 可选的 **Tavily API Key**，用于 Ask 联网搜索。只基于视频的 Ask 不需要 Tavily。

### 获取 Supadata API Key

1. 打开 Supadata 官方[注册页面](https://dash.supadata.ai/auth/sign-up)。
2. 创建账号并完成简短的新手引导。
3. Supadata 会在新手引导过程中自动生成 API Key。
4. 之后可以随时打开 [Supadata 控制台](https://dash.supadata.ai/)查找或管理 Key。
5. 复制 Key，并粘贴到 Speak Digest 设置中的 **Supadata API key**。

如果页面流程发生变化，请查看 [Supadata 官方文档](https://docs.supadata.ai/)。

### 获取 DeepSeek API Key

1. 打开 DeepSeek 官方 [API Keys 页面](https://platform.deepseek.com/api_keys)。
2. 按照提示登录，或创建 DeepSeek 开放平台账号。
3. 点击 **Create new API key**，填写容易识别的名称，例如 `Speak Digest`，然后创建 Key。
4. 立即复制 Key。完整 Key 可能只会显示一次。
5. 把 Key 粘贴到 Speak Digest 设置中的 **DeepSeek API key**。
6. 如果 DeepSeek 提示余额不足，请在 DeepSeek 开放平台账号中充值后再试。

当前账号和接口说明请查看 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。

### 获取可选的 Tavily API Key

1. 打开官方 [Tavily 控制台](https://app.tavily.com/home)。
2. 创建账号，并从 Tavily 账号复制 API Key。
3. 把 Key 粘贴到 Speak Digest 设置中的 **Tavily API key**。

Tavily 仍然采用用户自带 Key 的 BYOK 模式，而且完全可选。如果只需要基于当前视频问答，可以留空。开启联网搜索前，请查看 [Tavily API 介绍](https://docs.tavily.com/documentation/api-reference/introduction)、[额度文档](https://docs.tavily.com/documentation/api-credits) 和[隐私政策](https://tavily.com/privacy)。

在侧边栏中打开 **Settings**。你也可以在 `chrome://extensions` 的 Speak Digest 卡片中打开扩展选项。Key 只能粘贴到这些设置输入框中。不要把 Key 发送到 AI 对话、项目文件、截图或公开消息中。

发布版本只支持 DeepSeek V4 Flash：

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

Speak Digest 会让所有 DeepSeek 请求使用非思考模式，以获得更快、更稳定的交互。设置中的接口地址和模型固定，只需要填写 DeepSeek API Key。如果想使用其他服务或模型，请在设置中复制安全的自定义 prompt，让编程 Agent 修改你自己的本地副本。不要把任何 API Key 放进 prompt 或对话。

API Key 和设置保存在你设备上的 Chrome 扩展本地存储中。发布包不会包含或使用 `config.js`。

## 使用 Speak Digest

1. 打开一个普通 YouTube 视频页面。
2. 点击 Speak Digest 扩展图标，打开侧边栏。
3. 使用顶部四个 Tab：**Transcript**、**Overview**、**Library** 和 **Ask**。
4. 阅读带时间戳的字幕，或选择 **Original**、**中文**、**双语**。**Copy** 和 **Export** 会使用当前选中的语言。选择中文或双语时，扩展会先补齐尚未翻译的字幕段落；译文不完整时不会复制或导出。
5. 打开 **Overview**，以 **Original**、**中文** 或 **双语**查看全文摘要、章节和重点引用。
6. 选中字幕并选择 **Explain**。讲解可以显示为 **English**、**中文** 或 **双语**，不会改变选中的原文。
7. 打开 **Library**，在 **Notes** 和 **Vocabulary** 之间切换。从 Overview 保存重点引用时，笔记会保留当时显示的语言。
8. 打开 **Ask**，可以针对当前视频提问、使用推荐问题、总结、推荐相关内容或进行测验。

## 当前支持范围

- Chrome 116 或更高版本。
- 标准的 `youtube.com/watch` 视频页面。
- Supadata 能够返回的原生字幕。Speak Digest 会优先请求英文字幕，也可能显示其他可用的原生语言。
- 没有原生字幕时，由用户确认后从视频音轨生成 AI 转录。
- 原文、简体中文和双语对照字幕。
- 有上一个和下一个结果导航的有界字面 Transcript 搜索，并且与 Vocabulary 高亮兼容。
- 最多 20 个最近视频的会话级 Transcript 阅读位置恢复。
- 包含全文摘要的 AI 概览、英文/中文/双语选中文本讲解、翻译、Ask、单词信息和字幕笔记自动润色。
- Library 内包含本地 Notes 和 Vocabulary，以及按视频保存的字幕、概览和翻译缓存。
- 支持当前视频多轮 Ask、3 个视频专属推荐问题，以及由用户控制的 Tavily 联网搜索。
- 发布版本的所有 AI 功能都使用 DeepSeek V4 Flash。其他服务需要修改本地代码，不属于发布版本的支持范围。

侧边栏只使用当前活动的 YouTube 标签页。如果当前标签页不是支持的 YouTube 视频页，Speak Digest 会关闭或禁用侧边栏，而不是借用其他 YouTube 标签页的内容。

Shorts、直播、私密视频和受访问限制的视频可能无法使用。目前没有测试 Firefox、Safari、移动浏览器或其他 Chromium 浏览器。

Speak Digest 始终先使用 Supadata 的 `mode=native`。只有在没有原生字幕时，界面才会提供 **Generate transcript from audio**。只有用户点击按钮并确认预计额度后，插件才会发送付费的 `mode=generate` 请求。取消确认不会发送生成请求。插件不会在本地转录音频。

### Library 和 Vocabulary 行为

Library 包含相互独立的 **Notes** 和 **Vocabulary** 视图。一条 Vocabulary 会保存选中文本、中文释义和结合视频的解释、原句上下文、视频标题与时间戳。对较短的英文单词或短语，DeepSeek 还可能生成 IPA；对较短的中文词条，可能生成拼音。AI 生成的音标可能不完全准确，较长文本则会主动省略音标。Vocabulary 在本地最多保存 500 条。

保存后的 Vocabulary 会高亮显示在所有视频中的精确匹配字幕，包括当前和以后打开的视频。匹配过程会限制复杂度，也不会把收藏内容当成 HTML 或可执行模式。点击英文单词或短语的小喇叭时，优先请求有道词典的美式音频。若加载或播放失败，则切换浏览器语音，优先可用的美式 Natural、Google 声音，再到本地 Samantha。非英文词条直接使用浏览器语音。点击时会把该英文词条发送给有道；Speak Digest 不保存音频。浏览器语音可能使用联网声音，实际音色随设备而异。

### Ask 行为

Ask 只在当前视频内支持多轮追问。对话历史只保留在侧边栏内存中，不会持久化；切换视频或关闭侧边栏后会清空。每个视频恰好 3 个生成的推荐问题会在本地缓存。回答语言跟随最新问题。

**Web** 开关默认关闭。Web 关闭时，普通问题不会联系 Tavily。选择 **推荐相关内容** 会为该次请求开启 Tavily。如果缺少 Tavily Key、Tavily 不可用或搜索失败，Ask 会降级为只基于视频的回答，不会阻断对话。

## Supadata 免费额度和请求成本

截至 2026 年 8 月 9 日，[Supadata 价格页面](https://supadata.ai/pricing)显示免费版每月提供 **100 credits**，不需要信用卡，未使用的额度不会结转。价格可能变化，使用前请查看最新页面。

[Supadata 字幕接口文档](https://docs.supadata.ai/get-transcript)说明了不同模式的计费方式：

- 获取一次原生字幕消耗 **1 credit**，与视频时长无关。
- AI 生成字幕每分钟消耗 **2 credits**。Speak Digest 只会在用户明确确认后使用这条路径。
- 如果没有可用原生字幕并返回 HTTP `206`，仍会消耗 **1 credit**。

如果每次原生字幕请求都成功，免费版每月大约可以查询 100 个视频。重试、没有字幕的查询和用户选择的 AI 生成转录也会消耗额度，所以实际成功数量可能更少。

DeepSeek 的额度与 Supadata 分开计算。DeepSeek 可能有自己的免费额度、限速或费用。Speak Digest 不收款，也不转售 API 服务。建议为两个账号设置消费上限并定期查看用量。下方估算说明了当前 DeepSeek 翻译成本。

## 可选 Tavily 联网搜索和费用

只有你明确开启 Ask 的 **Web** 时，扩展才会从当前视频标题、你的问题和已有 Overview 派生搜索查询，然后使用你的 Tavily API Key 直接发送到 `https://api.tavily.com`。它使用 Basic Search，最多 5 个结果，不请求 Tavily answer，也不请求 raw content。只有验证过的来源 URL 会进入回答流程并显示为链接。网络内容只补充视频字幕，不会取代它。

截至 2026 年 8 月 23 日，Tavily 官方[额度文档](https://docs.tavily.com/documentation/api-credits)显示免费账号每月有 **1,000 credits**，Basic Search 每次使用 **1 credit**，Advanced Search 每次使用 **2 credits**。Speak Digest 使用 Basic Search，因此每次开启的搜索通常使用一个 Tavily credit。价格可能变化，使用这些数字前请查看最新 [API 文档](https://docs.tavily.com/documentation/api-reference/introduction)。Tavily 是可选的，使用你从 [Tavily 控制台](https://app.tavily.com/home)获取的 Key，并按 [Tavily 隐私政策](https://tavily.com/privacy)处理搜索。

## DeepSeek V4 Flash 翻译成本估算

截至 2026 年 8 月 29 日，DeepSeek 官方[价格页面](https://api-docs.deepseek.com/quick_start/pricing/)列出的 DeepSeek V4 Flash 每 100 万 token 价格是：

| Token 类型 | 非高峰时段 | 高峰时段 |
| --- | ---: | ---: |
| 缓存命中输入 | **$0.007 USD** | **$0.014 USD** |
| 缓存未命中输入 | **$0.22 USD** | **$0.44 USD** |
| 输出 | **$0.66 USD** | **$1.32 USD** |

高峰价格在周一至周五的 **01:00-04:00** 和 **06:00-10:00 UTC** 生效，其他时间使用非高峰价格。价格可能变化，使用此估算前请查看当前价格页面。官方 [token 用量指南](https://api-docs.deepseek.com/quick_start/token_usage/)估算每个英文字符约为 0.3 token，每个中文字符约为 0.6 token。[上下文缓存指南](https://api-docs.deepseek.com/guides/kv_cache/)说明了重复前缀使用的自动尽力而为磁盘缓存。

一个实测的 20 分钟英文演讲包含 **2,935 个英文口语词**和 15,433 个字幕字符。按 Speak Digest 当前的分组方式，它会变成 128 个语义分段，以每次 3 段的方式发出 43 次请求。算上重复 prompt 和 JSON 后，渲染后的输入约为 108,528 个英文字符，按官方每个英文字符 0.3 token 的经验值，即**约 32,600 个输入 token**。按每个中文字符 0.6 token 的经验值，再加上 JSON 和 ID 开销，中文 JSON 输出估计为 3,500 到 4,500 token。

完整翻译这段演讲的实用估算是：**非高峰时段 $0.003 到 $0.010 USD**，或 **高峰时段 $0.005 到 $0.020 USD**，主要取决于缓存命中情况和输出长度。

翻译是延迟按需和渐进式的。已缓存的分段会复用，只有滚动到并请求的字幕行才会发起调用。重试、服务商行为和价格变化都可能增加最终成本。

## 用编程 Agent 改造成自己的版本

这是一个个人 Remix 项目，不接受上游 Issue 或 Pull Request。如果功能出错，或者你想增加新功能，请下载或 Fork 自己的副本，再让你的编程 Agent 帮你修复、改造和个性化。

Speak Digest 使用原生 HTML、CSS 和 JavaScript，没有构建步骤，很适合用编程 Agent 做个人项目。你可以尝试：

- 增加更多翻译语言，并让每个人选择自己的学习语言。
- 为课程、访谈、教程、测评或研究视频增加自定义总结模板。
- 为现有单词本增加间隔复习、标签或自定义复习计划。
- 把笔记和生词导出到 Markdown、CSV、Anki 或其他学习工具。
- 增加个人主题筛选，只突出与你目标相关的章节。
- 增加本地模型选项，获得不同的隐私和成本方案。
- 改善键盘操作、字体大小和高对比度等无障碍体验。

请让 Agent 保留用户自带 API Key 的模式，不要把秘密写入源代码，并运行下方检查。分享自己的版本前，也要在真实视频上测试。

如果想使用其他 AI 服务或模型，请先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 Speak Digest 项目文件夹。然后打开 Speak Digest 设置并点击 **Copy customization prompt**。发送前替换 `[PROVIDER]` 和 `[MODEL]`，但不要加入任何 API Key。Agent 完成本地代码修改后，请你自己在它指出的设置位置填写 Key。

## 隐私和数据流向

Speak Digest 会直接从扩展向服务商发送请求：

1. 把标准化的 YouTube 视频地址发送给 Supadata，用于获取原生字幕。如果没有原生字幕，只有当你选择 **Generate transcript from audio** 并确认预计额度后，Supadata 才会处理视频音轨。
2. Overview 和 Ask 会把字幕和视频信息发送给 DeepSeek，Ask 只带有限的对话历史。Explain 和 Vocabulary 会发送选中文本和附近上下文；翻译只发送请求的内容。
3. Ask Web 开启时，把从标题、问题和可用 Overview 派生的查询直接发送给 Tavily。Web 默认关闭，保持关闭时不会向 Tavily 发送请求。
4. API Key、设置、Notes、Vocabulary、每个视频恰好 3 个缓存的推荐问题，以及字幕、概览和翻译缓存保存在 Chrome 本地。Ask 对话历史不会持久化。Transcript 阅读位置使用 Chrome 会话存储，浏览器会话结束后会被清除。
5. 点击英文词条发音时，该词条会发送至 `dict.youdao.com` 获取美式音频；失败时以及非英文词条使用浏览器语音。Speak Digest 不保存音频。

Speak Digest 没有账号系统、广告、分析统计或行为追踪。Supadata、DeepSeek、可选 Tavily 及点击后发起的有道音频请求会按照各自的条款和隐私政策处理数据。详情请查看 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### YouTube 视频页面没有显示 Digest 按钮

- 在 `chrome://extensions` 中找到 Speak Digest，点击“重新加载”，然后刷新 YouTube 页面。
- 确认当前页面是标准 `https://www.youtube.com/watch?...` 页面，而不是 Shorts、嵌入页面或直播页面。
- 当前版本会在 YouTube 响应式操作栏变化时自动重新定位按钮。页面加载完成后可以稍等片刻。
- 如果你使用的是较早下载的版本，可以先横向调整一次 YouTube 窗口宽度让按钮出现，然后下载最新版，这样之后不再需要调整窗口。
- 如果按钮仍然没有出现，让你的编程 Agent 在这个具体视频页面检查 content script。

### 侧边栏无法打开

- 确认你打开的是标准 `https://www.youtube.com/watch?...` 页面。
- 在 `chrome://extensions` 中确认 Speak Digest 已启用，并点击“重新加载”。
- 重新加载扩展后，刷新 YouTube 页面。
- 如果问题仍然存在，让你的编程 Agent 检查扩展。

### 侧边栏显示 YouTube connection lost

页面脚本缺失时，扩展会尝试自动重新连接当前 YouTube 标签页。如果仍失败，请刷新同一个 YouTube 页面，再点击侧边栏中的 **Retry connection**。

### Speak Digest 提示需要设置

- 打开 **Settings**，保存 Supadata Key 和 DeepSeek Key。只有需要 Ask 联网搜索时才添加 Tavily Key。
- 发布版本固定使用 DeepSeek V4 Flash，没有需要填写的 Base URL 或 Model 字段。
- 如果设置提示旧的自定义服务已移除，请重新填写 DeepSeek Key。旧 AI Key 已安全清除，避免被错误用于 DeepSeek。

### 找不到字幕

- 确认视频是公开的，并且 Supadata 可以访问。
- 检查 Supadata Key、剩余额度、限速和账号状态。
- 没有字幕的查询和手动重试也可能消耗额度。
- 如果视频没有原生字幕，选择 **Generate transcript from audio** 并查看预计成本。只有确认后才会发送请求，生成结果会缓存在本地供后续复用。

Speak Digest 永远不会自动开始付费的音轨转录。

### AI 请求失败

- `401` 或 `403` 通常表示 DeepSeek Key 或账号权限有问题。
- `429` 通常表示达到了 DeepSeek 服务限速或消费上限。
- 确认 Key 来自上方链接的 DeepSeek 开放平台账号，并且账号有可用额度。
- 如果你把本地副本改成了其他模型，请再次使用设置中的自定义 prompt，让编程 Agent 检查本地实现。
- 如果只有 Web 搜索失败，请检查可选 Tavily Key 和剩余额度。Ask 应继续返回只基于视频的回答。

不要在对话、截图或日志中分享 API Key、私密字幕或个人笔记。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run check
npm run package
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 YouTube 视频。自动检查通过，不代表真实服务请求和 YouTube 交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。
