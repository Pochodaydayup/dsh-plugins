# opencode-session

给**发往 OpenCode 网关**的请求补上 `x-opencode-session` 头。

## 解决什么

用 OpenCode Go（`https://opencode.ai/zen/go/v1`）当模型来源时，web 搜索会这样挂掉：

```
Error: DeepSeek API error (HTTP 400): Request is missing x-opencode-session and
cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it
The web search request used endpoint "https://opencode.ai/zen/go/v1/messages".
```

原因（读 opencode 官方文档 + `@deepseek-ai/dsh-web-search-deepseek` 源码确认过）：

1. OpenCode Go 要求客户端「**每个会话**发一个稳定的 session ID 在 `x-opencode-session` 里」，
   网关靠它做**路由与 prompt 缓存**；缺了它 `/v1/messages` 直接 400。
   （顺带一提，[文档的「已知问题客户端」名单](https://opencode.ai/docs/go/#known-problematic-clients)里就写着
   DeepSeek Harness：会话信息只在部分模型路径上传。）
2. 官方搜索插件的请求头是**写死的**（`x-api-key`/`authorization`/`anthropic-version`/
   `content-type`/`accept`/`user-agent`），config 只暴露
   `apiKey | apiKeyEnv | baseURL | model | apiVersion | maxTokens | maxUses`
   —— **没有加 header 的口子**；而且它用的是**自己的 `fetch`**，不经过 `ctx.llm`，
   所以「换 provider」这条路也堵死。

这个插件在**宿主原生 `fetch`** 外面包一层：命中配置域名的请求补头，其余请求原样放行。
它不关心请求是哪个插件发的，所以一次修好 web 搜索，**顺带也让对话请求带上会话头**
（官方建议所有适配器都发）。

## 装

设置 → 插件 → 安装，填**绝对路径** `/Users/zm00138ml/work/AI/dsh-plugins/opencode-session`，
然后**重启 App**（Host 半边）。没有界面，装上即生效，默认配置就够用。

装完把 web 搜索的 Endpoint 设成 `https://opencode.ai/zen/go/v1`（设置 → 插件 → 插件配置 → Web search）：
搜索请求会打到 `{baseURL}/messages`，也就是 `https://opencode.ai/zen/go/v1/messages`。

> **`model` 不用改**。实测 `deepseek-v4-flash`（插件默认值）和 `deepseek-v4.1-flash`
> 在这条路径上都支持 Anthropic 原生 `web_search_20250305` 工具，都会返回
> `web_search_tool_result` 块 —— 而插件正是靠这个块出结果的，缺了它会直接报
> 「returned no web_search_tool_result blocks」。这两个头（会话 + 原生搜索工具）齐了，
> 整条链路才通。

## 配置（都可选）

Loader 的 entry 里加 `config:`，例如：

```yaml
- insert:
    - id: opencode-session
      name: '@local/dsh-opencode-session'
      config:
        hosts: ['opencode.ai']          # 要补头的域名，支持子域；默认 ['opencode.ai']
        sessionHeader: x-opencode-session
        sessionId: my-fixed-id          # 强制指定；默认按下面的顺序解析
        userAgent: dsh-probe/1.0        # 只在请求没带 user-agent 时补
        headers:                        # 其它要补的头（已有同名头时不覆盖）
          x-whatever: '1'
        debug: false
```

会话 id 的解析顺序：`sessionId` 字面量 → 当前 DSH 会话的 `session-<n>` → 环境变量
`DSH_SESSION_ID` → 进程内固定的 `dsh-<pid>-<uuid>`。用 DSH 自己的会话号是为了让网关侧的
路由/缓存能和宿主里的会话对上号；任何一步探测失败都静默往下走，**不会让请求挂掉**。

## 行为边界

- 只补头：不改 body、不重试、不代理、不落盘、不记 key；
- 命中规则：域名相等或子域（`opencode.ai` 命中 `api.opencode.ai`）；
- 已有同名头**不覆盖**（别的客户端自带会话号时以它为准）；
- `Request` 对象入参也支持：先继承它自己的头，再补会话头；
- 相对 / 非法 URL 一律原样放行；
- 重复 apply 只包一层，卸载时恢复原生 `fetch`。

## 自测

```bash
node selftest.mjs      # 11 项，离线，不碰真接口
node ../check-manifests.mjs
```
